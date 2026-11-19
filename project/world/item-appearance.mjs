import {ATLAS_GRID, TILE_SIZE, coverBoxes, creativeIcon, itemShapeFor, sourceAtlasModel, tiles} from './geometry.mjs';
import {extractedModel} from './extracted-models.mjs';
import {heldLamp} from './held-light.mjs';
import {blockFaceVertices} from './block-faces.mjs';
import {isMicroPart,publicMicroPart} from './microblocks.mjs';

export function offhandAppearance(stack) {
  if (!stack) return null;
  if (isMicroPart(stack.part)) {
    return {kind:'block',key:`cover-material:${stack.part.material}`,part:publicMicroPart(stack.part)};
  }
  const {key,cell} = stack;
  const block = heldLamp(key) ? key : cell;
  if (typeof block === 'string' && /^(?:legacy|creative|cover|voxel):[a-z0-9:_-]+$/.test(block)) {
    return {kind:'block',key:block};
  }
  const item = /^creative:(\d+:\d+)$/.exec(key);
  return item ? {kind:'item',key:item[1]} : null;
}

const faceShade = [.8,.8,.55,1,.88,.88];
const fullUV = [[0,1],[1,1],[1,0],[0,0]];
const fullBlock = {x0:0,y0:0,z0:0,x1:1,y1:1,z1:1,faces:Array(6).fill(tiles.unknown),uv:'box'};

function atlasUV(tile, uv, rows, padding = .25 / TILE_SIZE) {
  if (tile < 0 || tile >= ATLAS_GRID * rows) tile = tiles.unknown;
  const x = tile % ATLAS_GRID, y = Math.floor(tile / ATLAS_GRID);
  const width = 1 - padding * 2;
  return uv.map(([u,v]) => [(x + padding + width * u) / ATLAS_GRID,(y + padding + width * v) / rows]);
}

function shadeOf(points) {
  const a = points[1].map((value,index) => value - points[0][index]);
  const b = points[2].map((value,index) => value - points[0][index]);
  const x = Math.abs(a[1]*b[2] - a[2]*b[1]);
  const ny = a[2]*b[0] - a[0]*b[2], y = Math.abs(ny);
  const z = Math.abs(a[0]*b[1] - a[1]*b[0]);
  return (x * faceShade[0] + y * faceShade[ny < 0 ? 2 : 3] + z * faceShade[4]) / (x+y+z) || 1;
}

function modelAppearance(family,surfaces,rows) {
  const vScale = family === 'terrain' ? ATLAS_GRID / rows : 1;
  return {family,sprite:false,quads:surfaces.map(({positions,uv,emissive,tint,mode})=>{
    const points = [0,3,6,9].map(index=>positions.slice(index,index+3));
    return {points,uv:[0,2,4,6].map(index=>[uv[index],uv[index+1]*vScale]),tint,
      shade:emissive ? 1 : shadeOf(points),mode};
  })};
}

export function blockItemAppearance(held,models,atlasRows=ATLAS_GRID) {
  const lamp = heldLamp(held.key);
  const cell = lamp ? {key:'legacy:768:0',object:{data:lamp}} : held;
  const model = !held.part && extractedModel(models,cell);
  if (model?.surfaces?.length) return modelAppearance(model.family,model.surfaces,atlasRows);
  const atlasModel = !held.part && sourceAtlasModel(cell);
  if (atlasModel?.length) return modelAppearance('terrain',atlasModel,atlasRows);
  const boxes = held.part ? coverBoxes([held.part]) : itemShapeFor(cell);
  if (boxes[0]?.kind === 'cross') {
    const {tile,tint} = creativeIcon(held);
    return {family:'terrain',sprite:true,quads:[{points:[[0,0,.5],[1,0,.5],[1,1,.5],[0,1,.5]],
      uv:atlasUV(tile,fullUV,atlasRows),shade:1,tint}]};
  }
  const quads = [];
  for (const box of boxes.length ? boxes : [fullBlock]) {
    for (let face = 0; face < 6; face++) {
      const tile = box.faces?.[face];
      if (!Number.isInteger(tile) || tile < 0) continue;
      const {points,uv} = blockFaceVertices(box,face);
      if (!uv.flat().every(Number.isFinite)) continue;
      quads.push({points,uv:atlasUV(tile,uv,atlasRows,box.redPowerAxes ? 0 : undefined),
        shade:box.emissive ? 1 : faceShade[face],tint:box.tintFaces?.[face] ?? box.tint,mode:box.mode});
    }
  }
  return {family:'terrain',sprite:false,quads};
}
