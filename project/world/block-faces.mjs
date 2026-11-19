const MIN = ['x0','y0','z0'];
const MAX = ['x1','y1','z1'];
const AXES = [[2,1],[1,2],[0,2],[2,0],[1,0],[0,1]];
const UV_AXES = [[2,1],[2,1],[0,2],[0,2],[0,1],[0,1]];
const cornersOfFace = [[0,0],[1,0],[1,1],[0,1]];

export function subtractBox(box,obstruction,axes) {
  const intersection={...box};
  for (const axis of axes) {
    const lower=MIN[axis], upper=MAX[axis];
    intersection[lower]=Math.max(box[lower],obstruction[lower]);
    intersection[upper]=Math.min(box[upper],obstruction[upper]);
    if (intersection[lower]>=intersection[upper]) return [box];
  }
  const remainder=[];
  const middle={...box};
  for (const axis of axes) {
    const lower=MIN[axis], upper=MAX[axis];
    if (middle[lower]<intersection[lower]) {
      remainder.push({...middle,[upper]:intersection[lower]});
      middle[lower]=intersection[lower];
    }
    if (middle[upper]>intersection[upper]) {
      remainder.push({...middle,[lower]:intersection[upper]});
      middle[upper]=intersection[upper];
    }
  }
  return remainder;
}

export const canClipBoxFace=box=>!box.kind && !box.angle && !box.fluid && !box.liquidSurface && !box.torchMount &&
  (box.mode==='opaque'||box.mode==='cutout');

function facePriority(box,face) {
  const alphaPriority=box.mode==='opaque'?0:65536;
  return alphaPriority+box.faces[face];
}

export function boxFaceFragments(box,boxIndex,boxes,face,neighborBoxes) {
  const axis=face>>1;
  const high=Boolean(face&1);
  const [outside,inside]=high?[MAX[axis],MIN[axis]]:[MIN[axis],MAX[axis]];
  const plane=box[outside];
  const priority=facePriority(box,face);
  const tangents=AXES[face];
  let fragments=[box];
  for (let i=0;i<boxes.length;i++) {
    const other=boxes[i];
    if (i===boxIndex || !canClipBoxFace(other)) continue;
    // Opaque geometry continuing past this face hides it, even for a partial overlap.
    const crosses=high?other[inside]<=plane && other[outside]>plane:other[inside]>=plane && other[outside]<plane;
    const coincident=other[outside]===plane && other.faces[face]!==-1;
    const candidate=facePriority(other,face);
    const wins=candidate<priority || candidate===priority && i<boxIndex;
    if (!(crosses && other.mode==='opaque') && !(coincident && wins)) continue;
    fragments=fragments.flatMap(fragment=>subtractBox(fragment,other,tangents));
    if (!fragments.length) return fragments;
  }
  const neighborEdge=high?0:1, neighborFace=face^1;
  for (const other of neighborBoxes??[]) {
    if (!canClipBoxFace(other) || (high?other[inside]>neighborEdge:other[inside]<neighborEdge)) continue;
    // Two opaque pieces hide their shared interior. Between two double-sided cutouts,
    // retain one face and use the lower-coordinate cell to break remaining ties.
    if (other.mode!=='opaque') {
      if (box.mode==='opaque' || other[inside]!==neighborEdge || other.faces[neighborFace]===-1) continue;
      const candidate=facePriority(other,neighborFace);
      if (candidate>priority || candidate===priority && high) continue;
    }
    fragments=fragments.flatMap(fragment=>subtractBox(fragment,other,tangents));
    if (!fragments.length) return fragments;
  }
  return fragments;
}

export function blockFaceVertices(box,face,quarter=-1,fragment=box) {
  const axis = face >> 1;
  const [uAxis,vAxis] = AXES[face];
  const [textureU,textureV] = UV_AXES[face];
  const points = [], uv = [];
  for (const [u,v] of cornersOfFace) {
    const point = [0,0,0];
    point[axis] = box[face & 1 ? MAX[axis] : MIN[axis]];
    point[uAxis] = fragment[u ? MAX[uAxis] : MIN[uAxis]];
    point[vAxis] = fragment[v ? MAX[vAxis] : MIN[vAxis]];
    if (box.liquidSurface && face !== 2 && point[1] === box.y1) {
      const [h00,h10,h01,h11] = box.liquidSurface;
      const [x,,z] = point;
      point[1] = (h00 + (h10 - h00) * x) * (1 - z) + (h01 + (h11 - h01) * x) * z;
    }
    let horizontal = point[textureU], vertical = point[textureV];
    if (box.uv === 'box') {
      horizontal = (horizontal - box[MIN[textureU]]) / (box[MAX[textureU]] - box[MIN[textureU]]);
      vertical = (vertical - box[MIN[textureV]]) / (box[MAX[textureV]] - box[MIN[textureV]]);
    }
    if ((face === 1 || face === 4) !== Boolean(box.mirrorFaces?.[face] ?? box.mirrorU)) horizontal = 1 - horizontal;
    if (box.redPowerUv) {
      let local = point;
      const localFace = box.redPowerFaces?.[face] ?? face;
      const localAxis = localFace >> 1;
      if (box.redPowerAxes) {
        local = [];
        for (const [i,component] of box.redPowerAxes.entries()) {
          const inset = point[i] - (box.redPowerOffset?.[i] ?? 0) + (point[i] === box[MIN[i]] ? .001 : -.001);
          local[Math.abs(component) - 1] = component > 0 ? inset : 1 - inset;
        }
      }
      horizontal = local[localAxis === 2 ? 0 : 2];
      if (localFace === 1 || localFace === 2 || localFace === 4) horizontal = 1 - horizontal;
      vertical = 1 - local[localAxis === 1 ? 0 : 1];
      const flags = box.redPowerUv[face];
      if (flags & 1) horizontal = 1 - horizontal;
      if (flags & 2) vertical = 1 - vertical;
      uv.push(flags & 4 ? [vertical,horizontal] : [horizontal,vertical]);
    } else {
      const textureY = axis === 1 ? vertical : 1 - vertical;
      let u = horizontal, v = textureY;
      if (box.paneCrosswiseUV) [u,v] = [v,1-u];
      if (face === 3 && box.bedFacing !== undefined) {
        [u,v] = [[v,u],[1-u,v],[1-v,1-u],[u,1-v]][box.bedFacing];
      }
      uv.push([u,v]);
      if (quarter >= 0) {
        const quarterU = ((quarter & 1) + horizontal) / 2;
        const quarterV = ((quarter >> 1) + textureY) / 2;
        point[textureU] = face === 1 || face === 4 ? 1 - quarterU : quarterU;
        point[textureV] = axis === 1 ? quarterV : 1 - quarterV;
      }
    }
    if (box.angle) {
      const [x,y,z] = [point[0] - .5, point[1], point[2] - .5];
      const sin = Math.sin(box.angle), cos = Math.cos(box.angle);
      points.push([.5 + x * cos + z * sin,y,.5 + z * cos - x * sin]);
    } else points.push(point);
  }
  return {points,uv};
}
