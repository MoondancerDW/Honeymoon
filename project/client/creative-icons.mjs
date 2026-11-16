import {ATLAS_GRID,TILE_SIZE,coverBoxes,creativeIcon,shapeFor} from '../world/geometry.mjs';
import {creativeMicroblock,shapedLampData} from '../world/creative-items.mjs';

const images = new Map();
const pixels = new Map();
const loadImage = source => {
  if (!images.has(source)) {
    const image = new Image();
    image.src = source;
    images.set(source,image.decode().then(()=>image).catch(error=>{ images.delete(source); throw error; }));
  }
  return images.get(source);
};

const components = tint => Array.isArray(tint) ? tint :
  Number.isInteger(tint) ? [tint>>16&255,tint>>8&255,tint&255] : [255,255,255];

function atlasTile(atlas,tile,tint,shade = 1) {
  if (!Number.isInteger(tile) || tile < 0) return null;
  const x = tile%ATLAS_GRID*TILE_SIZE, y = Math.floor(tile/ATLAS_GRID)*TILE_SIZE;
  if (y+TILE_SIZE > atlas.naturalHeight) return null;
  const rgb = components(tint);
  const key = [tile,...rgb,shade].join(':');
  if (pixels.has(key)) return pixels.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(atlas,x,y,TILE_SIZE,TILE_SIZE,0,0,TILE_SIZE,TILE_SIZE);
  if (shade !== 1 || rgb.some(value=>value !== 255)) {
    const image = ctx.getImageData(0,0,TILE_SIZE,TILE_SIZE);
    for (let i=0;i<image.data.length;i+=4) for (let channel=0;channel<3;channel++) {
      image.data[i+channel] *= rgb[channel]*shade/255;
    }
    ctx.putImageData(image,0,0);
  }
  pixels.set(key,canvas);
  return canvas;
}

const project = ([x,y,z]) => [16+(x+z-1)*13,3+(x-z+1)*6.5+(1-y)*14];
function faces({x0,y0,z0,x1,y1,z1,faces:tiles,tint,tintFaces}) {
  return [
    [3,[[x0,y1,z1],[x1,y1,z1],[x0,y1,z0]],1],
    [4,[[x0,y1,z0],[x1,y1,z0],[x0,y0,z0]],.8],
    [1,[[x1,y1,z0],[x1,y1,z1],[x1,y0,z0]],.6],
  ].map(([face,points,shade])=>({
    points:points.map(project), tile:tiles?.[face], shade, tint:tintFaces?.[face] ?? tint,
    depth:points.reduce((sum,[x,y,z])=>sum+x-z+y*.85,0),
  }));
}

function paintFace(context,canvas,atlas,{points:[a,b,c],tile,tint,shade}) {
  const image = atlasTile(atlas,tile,tint,shade);
  if (!image) return;
  const scale = canvas.width/32;
  context.save();
  context.setTransform((b[0]-a[0])*scale,(b[1]-a[1])*scale,(c[0]-a[0])*scale,(c[1]-a[1])*scale,a[0]*scale,a[1]*scale);
  context.drawImage(image,0,0,1,1);
  context.restore();
}

export async function renderCreativeIcon(entry,canvas,items) {
  const sprite = items?.[entry.id + ':' + (entry.invisible ? 0 : entry.damage ?? entry.meta ?? 0)];
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.imageSmoothingEnabled = false;
  context.clearRect(0,0,canvas.width,canvas.height);
  if (sprite?.uv && !sprite.block) {
    const image = await loadImage('/generated/models/biblio.png');
    const [u0,v0,u1,v1] = sprite.uv;
    context.drawImage(image,u0*image.width,v0*image.height,(u1-u0)*image.width,(v1-v0)*image.height,
      0,0,canvas.width,canvas.height);
    return true;
  }

  const atlas = await loadImage('/generated/textures/atlas.png');
  const part = entry.kind === 'microblock' ? entry.part ?? creativeMicroblock(entry) : null;
  const marker = {...entry,part,key:entry.blockKey ?? entry.key,
    ...(entry.kind === 'shaped-lamp' && {data:shapedLampData(entry.damage),lit:Boolean(entry.damage&16)})};
  const info = creativeIcon(marker);
  const shapes = part ? coverBoxes([part]) :
    marker.key?.startsWith('legacy:') ? shapeFor(marker.key) : [];
  const solid = shapes.length && shapes.every(shape=>(!shape.kind || shape.kind === 'box') &&
    shape.mode !== 'decal' && Number.isFinite(shape.x0));
  if (solid) {
    const sorted = shapes.flatMap(faces).sort((a,b)=>a.depth-b.depth);
    for (const face of sorted) paintFace(context,canvas,atlas,face);
    return true;
  }
  const texture = atlasTile(atlas,info.tile,info.tint);
  if (!texture) return false;
  context.drawImage(texture,0,0,canvas.width,canvas.height);
  return true;
}
