const atlasWidth = 64;
const atlasHeight = 32;
const pixel = 1 / 16;

function modelBox([x0,y0,z0], [w,h,d], [u,v], transform) {
  const x1 = x0 + w, y1 = y0 + h, z1 = z0 + d;
  const vertices = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
    [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const a = u + d, b = a + w, c = b + d, e = c + w;
  const top = v + d, bottom = top + h;
  return [
    [[5,1,2,6],[b,top,c,bottom]], [[0,4,7,3],[u,top,a,bottom]],
    [[5,4,0,1],[a,v,b,top]], [[2,3,7,6],[b,top,b + w,v]],
    [[1,0,3,2],[a,top,b,bottom]], [[4,5,6,7],[c,top,e,bottom]],
  ].map(([face,[u0,v0,u1,v1]]) => ({
    positions:face.flatMap(index => transform(...vertices[index])),
    uv:[[u1,v0],[u0,v0],[u0,v1],[u1,v1]].flatMap(([u,v]) => [
      (u + (u === Math.min(u0,u1) ? .25 : -.25)) / atlasWidth,
      (v + (v === Math.min(v0,v1) ? .25 : -.25)) / atlasHeight,
    ]),
  }));
}

// The legacy ModelBoat uses a rotated floor, two end boards and two side boards.
// Convert its model coordinates into the boat's local space, with Y=0 at the water.
const local = (x,y,z) => [z * pixel, (4 - y) * pixel, x * pixel];
const side = transform => modelBox([-10,-7,-1], [20,6,2], [0,0], transform);
const surfaces = [
  ...modelBox([-12,-8,-3], [24,16,4], [0,8], (x,y,z) => local(x,4 - z,y)),
  ...side((x,y,z) => local(-11 - z,4 + y,x)),
  ...side((x,y,z) => local(11 + z,4 + y,-x)),
  ...side((x,y,z) => local(-x,4 + y,-9 - z)),
  ...side((x,y,z) => local(x,4 + y,9 + z)),
];

export function boatModel(terrainRows) {
  if (!terrainRows) return surfaces;
  return surfaces.map(({positions,uv}) => ({
    positions, uv:uv.map((value,index) => index & 1 ? value / terrainRows : (4 + value) / 64),
  }));
}
