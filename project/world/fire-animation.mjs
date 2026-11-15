export const FIRE_SIZE = 16;
export const FIRE_FRAMES = 96;
export const FIRE_STEP_MS = 50;

// The old client generates two terrain flame tiles in TextureHDFlamesFX.
export function fireSpriteSheet() {
  const width = FIRE_SIZE, height = width + width / 4;
  const damping = 1.01 + .8 / width;
  const pixels = new Uint8Array(width * 2 * width * FIRE_FRAMES * 4);
  let seed = 226448;
  const random = () => {
    seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let layer=0;layer<2;layer++) {
    const fuel = Float32Array.from({length:FIRE_FRAMES*width},() => random()*random()*random()*4 + random()*.1 + .2);
    let heat = new Float32Array(width*height);
    let next = new Float32Array(heat.length);
    for (let tick=-2*FIRE_FRAMES;tick<FIRE_FRAMES;tick++) {
      const frame = (tick+2*FIRE_FRAMES) % FIRE_FRAMES;
      for (let y=0;y<height-1;y++) for (let x=0;x<width;x++) {
        const strength = height - width / 8;
        const at = y*width+x;
        let total = heat[at+width]*strength;
        for (let column=Math.max(0,x-1); column<=Math.min(width-1,x+1); column++) {
          total += heat[y*width+column] + heat[(y+1)*width+column];
        }
        next[at] = total / ((strength+6)*damping);
      }
      next.set(fuel.subarray(frame*width,(frame+1)*width),(height-1)*width);
      [heat,next] = [next,heat];
      if (tick < 0) continue;
      for (let y=0;y<width;y++) for (let x=0;x<width;x++) {
        const intensity = Math.min(1,heat[x+y*width]*1.8);
        const at = (x + layer*width + (width-1-y+frame*width)*2*width)*4;
        pixels[at] = 100+intensity*155;
        pixels[at+1] = intensity**2*255;
        pixels[at+2] = intensity**10*255;
        pixels[at+3] = intensity >= .5 ? 255 : 0;
      }
    }
  }
  return pixels;
}
