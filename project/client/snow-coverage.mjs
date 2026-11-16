const arrivalPadding=4;

function sampleOffset(x,z,salt) {
  let hash=Math.imul(x^salt,0x1f123bb5)^Math.imul(z+salt,0x5f356495);
  hash=Math.imul(hash^hash>>>16,0x7feb352d);
  return (hash^hash>>>15)&3;
}

export function snowColumnBand(x,z) {
  const pairX=x>>1,pairZ=z>>1;
  if (((x&1)+2*(z&1))!==sampleOffset(pairX,pairZ,137)) return 0;
  return ((pairX&1)+2*(pairZ&1))===sampleOffset(pairX>>1,pairZ>>1,229) ? 2 : 1;
}

function layout(step,range,start,probes) {
  const radius=range[1]+arrivalPadding;
  const scanRadius=Math.ceil(radius/step);
  const offsets=[];
  for (let z=-scanRadius;z<=scanRadius;z++) for (let x=-scanRadius;x<=scanRadius;x++) {
    const distance=(x*x+z*z)*step*step;
    if (distance>=start*start && distance<=radius*radius) offsets.push({x,z,distance});
  }
  offsets.sort((a,b)=>a.distance-b.distance || a.z-b.z || a.x-b.x);
  return {step,range,radius,offsets,probes,capacity:(scanRadius*2+3)**2};
}

const desktop={bands:[layout(1,[8,14],0,12),layout(2,[19,30],7,9),layout(4,[34,48],18,9)],
  vertical:[64,104],detail:[6,12],grainLimit:75};
const phone={bands:[layout(1,[6,11],0,9),layout(2,[14,24],5,7),layout(4,[27,38],13,7)],
  vertical:[52,88],detail:[5,9],grainLimit:35};

export const snowCoverage=mobile=>mobile?phone:desktop;

export function sampleSnowLane(band,cursor,x,z) {
  const {step,offsets}=band;
  const offset=offsets[cursor%offsets.length];
  x=Math.floor(x/step)+offset.x;
  z=Math.floor(z/step)+offset.z;
  if (step===1) return [x,z];
  if (step===4) {
    const group=sampleOffset(x,z,229);
    x=x*2+(group&1);
    z=z*2+(group>>1);
  }
  const cell=sampleOffset(x,z,137);
  return [x*2+(cell&1),z*2+(cell>>1)];
}
