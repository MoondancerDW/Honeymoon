const breeds = new Map([
  [0xf9b131, 'earth'], [0xd0cccf, 'earth'], [0x88caf0, 'pegasus'],
  [0xd19fe4, 'unicorn'], [0xfef9fc, 'alicorn'], [0x282b29, 'alicorn'],
]);
const tails = new Map([[0x8a6b7f, 1], [0x534b76, 2], [0x468e88, 3], [0x425844, 4]]);
const sizes = new Map([[0xffbe53, 'small'], [0xce3254, 'large'], [0x2a3c78, 'tall']]);
const manes = new Map([[0x280000, 1], [0x0a0000, 2], [0x140000, 3], [0x1e0000, 4]]);

export const ponySizeMarker = rgb => sizes.get(rgb) ?? 'normal';

export const skinSizes = ['64x32', '64x64', '128x64', '256x128', '512x256'];
export const maxSkinBytes = 576 * 1024;

export function ponySkinHeight(width, height) {
  const scale = width / 64;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) return 0;
  return height === 32 * scale || height === 64 * scale ? 32 * scale : 0;
}

export function readPonySkin(pixels, width, height) {
  const skinHeight = ponySkinHeight(width, height);
  if (!skinHeight || pixels.length < width * skinHeight * 4) throw new RangeError('Invalid pony skin atlas');
  const glowPixel = width * 4;
  const glowColor = pixels[glowPixel] << 16 | pixels[glowPixel + 1] << 8 | pixels[glowPixel + 2];
  const glowAlpha = pixels[glowPixel + 3];
  function rgb(x, y) {
    const i = (y * width + x) * 4;
    return pixels[i + 3] === 255 ? pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2] : -1;
  }
  // Mine Little Pony reads header markers at absolute pixels even on HD skins.
  const scale = Math.floor(height / 32);
  let advanced = false;
  if (pixels[4 * scale * 4 + 3] !== 0) {
    for (let y = 0; y < 8 * scale && !advanced; y++) {
      for (let x = 4 * scale; x < 8 * scale; x++) {
        if (rgb(x, y) !== 0) {
          advanced = true;
          break;
        }
      }
    }
  }
  return {
    ponyType: breeds.get(rgb(0, 0)) ?? 'earth',
    tail: tails.get(rgb(1, 0)) ?? 0,
    male: rgb(2, 0) === 0xffffff,
    size: ponySizeMarker(rgb(3, 0)),
    mane: manes.get(rgb(1, 1)) ?? 0,
    glowColor: glowAlpha !== 0 && (glowAlpha !== 255 || glowColor !== 0) ? glowColor : 0x4444aa,
    advanced,
  };
}

export function defaultPonyPixels() {
  // An original 64x32 palette. The overlay is clear over the face and ears.
  const pixels = new Uint8Array(64 * 32 * 4);
  const coat = [201, 153, 119], hair = [86, 60, 105], hairLight = [113, 77, 135];
  const eye = [252, 246, 229], iris = [102, 61, 142], pupil = [35, 26, 54];
  const hoof = [139, 99, 105], muzzle = [227, 178, 142];
  const clear = [0, 0, 0, 0];
  function rect(x, y, width, height, color) {
    for (let row = y; row < y + height; row++) {
      for (let col = x; col < x + width; col++) {
        const i = (row * 64 + col) * 4;
        pixels.set(color, i);
        pixels[i + 3] = color[3] ?? 255;
      }
    }
  }
  rect(0, 0, 64, 32, coat);
  rect(0, 0, 8, 8, clear);
  rect(0, 0, 1, 1, [249, 177, 49]);
  rect(32, 0, 32, 16, clear);
  rect(32, 0, 8, 8, hair);
  rect(36, 0, 1, 8, hairLight);
  rect(40, 0, 8, 8, hair);
  rect(43, 1, 2, 7, hairLight);
  rect(32, 8, 8, 2, hair);
  rect(48, 8, 8, 2, hair);
  rect(40, 8, 8, 1, hair);
  rect(56, 8, 8, 7, hair);
  rect(58, 9, 2, 6, hairLight);
  for (const x of [5, 9, 13, 16]) {
    rect(x, 10, 3, 3, eye);
    rect(x + (x < 12 ? 1 : 0), 11, 2, 2, iris);
    rect(x + 1, 11, 1, 2, pupil);
  }
  rect(10, 14, 4, 2, muzzle);
  rect(10, 14, 1, 1, hoof);
  rect(13, 14, 1, 1, hoof);
  rect(14, 18, 1, 1, muzzle);
  rect(40, 29, 16, 3, hoof);
  rect(16, 29, 8, 3, hoof);
  return pixels;
}
