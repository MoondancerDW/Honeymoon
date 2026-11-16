export const canopyCardSize=32;

const blades=[
  [14,14,10,4,.30,154], [8,15,7,3,.74,143], [21,20,8,4,-.36,136],
  [16,23,7,3,1.13,166], [22,12,6,3,-.86,177], [10,8,6,3,.86,181],
  [27,17,5,2.8,-.42,159], [17,6,5,2.6,-.94,190], [5,19,4,2.7,.25,128],
  [23,25,4,2.1,.44,168], [12,25,4,2.1,.75,162], [6,10,4,2.2,.48,178],
];

export function canopyCardPixels() {
  const pixels=new Uint8Array(canopyCardSize*canopyCardSize*4);
  for (const [cx,cy,length,width,angle,value] of blades) {
    const cos=Math.cos(angle), sin=Math.sin(angle);
    for (let y=0;y<canopyCardSize;y++) for (let x=0;x<canopyCardSize;x++) {
      const dx=x+.5-cx, dy=y+.5-cy;
      const across=-dx*sin+dy*cos, along=dx*cos+dy*sin;
      const taper=1-(along/length)**2;
      if (taper<=0 || Math.abs(across)>width*taper**.75) continue;
      const i=(y*canopyCardSize+x)*4;
      const vein=across>=0 && across<.68 ? 17 : 0;
      const grain=(Math.imul(x+2,31)^Math.imul(y+3,53))&15;
      const shade=value+(across<0 ? 13 : -11)+vein+grain;
      pixels[i]=pixels[i+1]=pixels[i+2]=shade;
      pixels[i+3]=255;
    }
  }
  return pixels;
}
