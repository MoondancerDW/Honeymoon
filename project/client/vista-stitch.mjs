const CHUNK_BLOCKS = 16;
const TILE_CHUNKS = 4;
const EDGE_POINTS = 3;
const EDGE_STRIDE = EDGE_POINTS * 2;
const CHUNK_STRIDE = 4 * EDGE_STRIDE;
const EDGES = [[-1,0],[1,0],[0,-1],[0,1]];

export const VISTA_STITCH_FACE = 512;
export const VISTA_STITCH_LIMIT = 3;

function recordEdge(profile,edge,start,end,y,tile) {
  for (let k=0; k<EDGE_POINTS; k++) {
    const point = k*CHUNK_BLOCKS/(EDGE_POINTS-1);
    if (point<start || point>end) continue;
    const at = edge+k*2;
    if (profile[at]>=y) continue;
    profile[at]=y;
    profile[at+1]=tile;
  }
}

export function lodBoundaryHeights({count, offset, span, surface,coordinateScale=1,heightScale=1}) {
  const profile = new Uint16Array(TILE_CHUNKS ** 2 * CHUNK_STRIDE);
  for (let i=0; i<count; i++) {
    const face = surface[i*2+1];
    if ((face & 7)!==3 || face & 256) continue;
    const chunk = face >> 3 & 15;
    const x = offset[i*3]/coordinateScale - (chunk & 3)*CHUNK_BLOCKS;
    const y = offset[i*3+1]/heightScale;
    const z = offset[i*3+2]/coordinateScale - (chunk >> 2)*CHUNK_BLOCKS;
    const east = x + span[i*2+1]/coordinateScale;
    const south = z + span[i*2]/coordinateScale;
    const tile = surface[i*2];
    const from = chunk*CHUNK_STRIDE;
    if (x===0) recordEdge(profile,from,z,south,y,tile);
    if (east===CHUNK_BLOCKS) recordEdge(profile,from+EDGE_STRIDE,z,south,y,tile);
    if (z===0) recordEdge(profile,from+2*EDGE_STRIDE,x,east,y,tile);
    if (south===CHUNK_BLOCKS) recordEdge(profile,from+3*EDGE_STRIDE,x,east,y,tile);
  }
  return profile;
}

export function writeVistaStitch(field, coverage, sources, size, minX, minZ) {
  field.fill(0);
  const width = size*2+1;
  for (let z=0; z<size; z++) for (let x=0; x<size; x++) {
    const region = sources[x+z*size];
    if (!region?.boundary) continue;
    const chunk = (x+minX-region.rx*TILE_CHUNKS) + TILE_CHUNKS*(z+minZ-region.rz*TILE_CHUNKS);
    if (chunk<0 || chunk>=TILE_CHUNKS**2) continue;
    for (let side=0; side<EDGES.length; side++) {
      const [dx,dz]=EDGES[side];
      const nx=x+dx, nz=z+dz;
      if (nx<0 || nz<0 || nx>=size || nz>=size || coverage[nx+nz*size]) continue;
      const from=chunk*CHUNK_STRIDE+side*EDGE_STRIDE;
      const edgeX=x*2+Number(dx>0)*2;
      const edgeZ=z*2+Number(dz>0)*2;
      for (let k=0; k<EDGE_POINTS; k++) {
        const y=region.boundary[from+k*2];
        if (!y) continue;
        const at=((edgeX+(dz ? k : 0))+(edgeZ+(dx ? k : 0))*width)*2;
        // A convex corner is shared by two exposed edges. Use the higher
        // of their top faces, like the profile of an individual edge vertex.
        if (field[at]>y) continue;
        field[at]=y;
        field[at+1]=region.boundary[from+k*2+1];
      }
    }
  }
}
