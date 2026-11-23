import {signalSides} from './block-interactions.mjs';
import {intersectSelection} from './selection.mjs';

export const paintingItemKey = 'creative:321:0';
export const paintingArt = Object.freeze({
  Kebab:[0,0,16,16], Aztec:[16,0,16,16], Alban:[32,0,16,16], Aztec2:[48,0,16,16],
  Bomb:[64,0,16,16], Plant:[80,0,16,16], Wasteland:[96,0,16,16], Pool:[0,32,32,16],
  Courbet:[32,32,32,16], Sea:[64,32,32,16], Sunset:[96,32,32,16], Creebet:[128,32,32,16],
  Wanderer:[0,64,16,32], Graham:[16,64,16,32], Match:[0,128,32,32], Bust:[32,128,32,32],
  Stage:[64,128,32,32], Void:[96,128,32,32], SkullAndRoses:[128,128,32,32],
  Wither:[160,128,32,32], Fighters:[0,96,64,32], Pointer:[0,192,64,64],
  Pigscene:[64,192,64,64], BurningSkull:[128,192,64,64], Skeleton:[192,64,64,48], DonkeyKong:[192,112,64,48],
});

const sides = [3,4,2,5];
const rotation = [0,-Math.PI/2,Math.PI,Math.PI/2];

function legacyDirection(direction) {
  return direction ^ (direction & 1 ? 0 : 2);
}

export function isDecoration(entity) {
  return entity?.type === 'ItemFrame' || entity?.type === 'Painting';
}

export function paintingMount(entity) {
  const {Motive,Dir,Direction}=entity?.data??{};
  const art=Object.hasOwn(paintingArt,Motive) && paintingArt[Motive];
  const direction=Number.isInteger(Dir) && Dir>=0 && Dir<4 ? legacyDirection(Dir) : Direction;
  const side=sides[direction];
  const center=entity?.position;
  if (!art || side===undefined || !Array.isArray(center) || center.length!==3 || !center.every(Number.isFinite)) return;
  const normal=signalSides[side];
  const width=art[2]/16, height=art[3]/16;
  const horizontal=normal[0]===0?0:2;
  const depth=2-horizontal;
  const lo=[...center], hi=[...center];
  lo[horizontal]-=width/2;
  hi[horizontal]+=width/2;
  lo[1]-=height/2;
  hi[1]+=height/2;
  lo[depth]-=1/256;
  hi[depth]+=1/256;
  const bounds={x0:lo[0],y0:lo[1],z0:lo[2],x1:hi[0],y1:hi[1],z1:hi[2]};
  const supports=[];
  for (let x=0;x<width;x++) for (let y=0;y<height;y++) {
    const support=[];
    support[horizontal]=Math.floor(lo[horizontal]+x+1e-6);
    support[depth]=Math.floor(center[depth]-normal[depth]/8);
    support[1]=Math.floor(lo[1]+y+1e-6);
    supports.push(support);
  }
  return {center,normal,side,rotationY:rotation[direction],art,bounds,supports};
}

export function paintingAt(support,side,Motive) {
  const direction=sides.indexOf(side);
  const art=paintingArt[Motive];
  if (direction<0 || !art) return;
  const [TileX,TileY,TileZ]=support;
  const [nx,,nz]=signalSides[side];
  const horizontal=(art[2]/16 & 1)===0 ? .5 : 0;
  const vertical=(art[3]/16 & 1)===0 ? .5 : 0;
  const position=[TileX+.5+nx*.5625+nz*horizontal,TileY+.5+vertical,TileZ+.5+nz*.5625-nx*horizontal];
  const key=`painting:${support.join(':')}:${side}`;
  return {type:'Painting',key,position,data:{TileX,TileY,TileZ,Motive,Direction:direction,Dir:legacyDirection(direction)},placed:true};
}

export function paintingHit(entity,origin,direction,range=6) {
  const mount=paintingMount(entity);
  return mount ? intersectSelection(origin,direction,mount.bounds,0,0,0,range)?.length??Infinity : Infinity;
}
