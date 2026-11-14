import {carpentryQuads, carpentryTile} from './carpentry-model-data.mjs';

// Original TESR rotates about the cell center after mirroring the model's X and Y.
const variants = [];
export function carpentryModel(meta) {
  const turn = meta & 3;
  if (!variants[turn]) {
    const cosine = [1, 0, -1, 0][turn], sine = [0, 1, 0, -1][turn];
    const u0 = (carpentryTile % 64) / 64, v0 = Math.floor(carpentryTile / 64) / 64;
    variants[turn] = carpentryQuads.map(([source, uv]) => {
      const positions = [];
      for (let i = 0; i < 12; i += 3) {
        const x = source[i] - .5, z = source[i + 2] - .5;
        positions.push(.5 + x * cosine - z * sine, source[i + 1], .5 + x * sine + z * cosine);
      }
      return {positions, uv:uv.map((value, i) => i & 1 ? v0 + value / 16 : u0 + value / 8)};
    });
  }
  return variants[turn];
}
