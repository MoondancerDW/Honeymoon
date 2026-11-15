import * as THREE from '/vendor/three/three.module.js';
import {ATLAS_GRID as columns, TILE_SIZE as tileSize, tiles} from '../world/geometry.mjs';

const filteredSize = 4;
const stride = filteredSize + 2;
const linear = Array.from({length:256}, (_, value) => {
  const norm = value / 255;
  return norm <= .04045 ? norm / 12.92 : ((norm + .055) / 1.055) ** 2.4;
});
const encode = value => Math.round(255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055));

export function terrainFilter(source, rows) {
  const canvas = document.createElement('canvas');
  canvas.width = source.image.width;
  canvas.height = source.image.height;
  const context = canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(source.image,0,0);
  const pixels = context.getImageData(0,0,canvas.width,canvas.height).data;
  const width = columns * stride, height = rows * stride;
  const averages = new Uint8Array(columns * rows * 4);
  const filtered = new Uint8Array(width * height * 4);
  const sum = new Float32Array(filteredSize ** 2 * 4);
  const reduced = new Uint8Array(sum.length);
  for (let y=0; y<rows; y++) for (let x=0; x<columns; x++) {
    sum.fill(0);
    for (let py=0; py<tileSize; py++) for (let px=0; px<tileSize; px++) {
      const from = ((y * tileSize + py) * canvas.width + x * tileSize + px) * 4;
      const to = ((px >> 2) + (py >> 2) * filteredSize) * 4;
      const alpha = pixels[from+3];
      for (let channel=0; channel<3; channel++) sum[to+channel] += linear[pixels[from+channel]] * alpha;
      sum[to+3] += alpha;
    }
    const total = [0,0,0,0];
    for (let at=0; at<sum.length; at+=4) {
      for (let channel=0; channel<4; channel++) total[channel] += sum[at+channel];
    }
    const average = total.slice(0,3).map(value => value / Math.max(1,total[3]));
    averages.set([...average.map(encode),Math.round(total[3] / 256)],(x+(rows-1-y)*columns)*4);
    for (let at=0; at<sum.length; at+=4) {
      for (let channel=0; channel<3; channel++) {
        reduced[at+channel] = encode(sum[at+3] ? sum[at+channel] / sum[at+3] : average[channel]);
      }
      reduced[at+3] = Math.round(sum[at+3] / 16);
    }
    // Opposite-edge padding wraps repeating block faces without atlas bleed.
    for (let dy=0; dy<stride; dy++) for (let dx=0; dx<stride; dx++) {
      const from = (((dy + 3) % filteredSize) * filteredSize + (dx + 3) % filteredSize) * 4;
      const to = (x*stride + dx + (height-1-(y*stride + dy))*width)*4;
      filtered.set(reduced.subarray(from,from+4),to);
    }
  }
  const mid = new THREE.DataTexture(filtered,width,height);
  const average = new THREE.DataTexture(averages,columns,rows);
  const waterPixels = new Uint8Array(tileSize * tileSize * 4);
  // Trilinear sampling must wrap within the water tile. Its right-hand
  // neighbor in the shared atlas is lava.
  const waterX = (tiles.water % columns) * tileSize;
  const waterY = Math.floor(tiles.water / columns) * tileSize;
  for (let y=0; y<tileSize; y++) {
    const from = (waterX + (waterY+y)*canvas.width)*4;
    waterPixels.set(pixels.subarray(from,from+tileSize*4),(tileSize-1-y)*tileSize*4);
  }
  const water = new THREE.DataTexture(waterPixels,tileSize,tileSize);
  water.wrapS = water.wrapT = THREE.RepeatWrapping;
  water.minFilter = THREE.LinearMipmapLinearFilter;
  water.generateMipmaps = true;
  mid.magFilter = mid.minFilter = THREE.LinearFilter;
  for (const texture of [mid,average,water]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }
  return {source, mid, average, water};
}

const uniforms = `
  uniform sampler2D terrainMid;
  uniform sampler2D terrainAverage;
  uniform float terrainRows;`;

const sampling = `
  vec4 terrainSample(sampler2D source, vec2 cell, vec2 within, float footprint) {
    vec2 grid = vec2(64.0, terrainRows);
    vec2 uv = (cell + clamp(within, vec2(.03125), vec2(.96875))) / grid;
    vec2 midUv = (cell + (1.0 + within * 4.0) / 6.0) / grid;
    vec2 meanUv = (cell + .5) / grid;
    vec4 result = vec4(0.0);
    if (footprint >= .66) {
      result = texture2D(terrainAverage, meanUv);
    } else {
      result = texture2D(source, uv);
      if (footprint > .065) {
        vec4 mid = texture2D(terrainMid, midUv);
        vec4 low = mix(mid, texture2D(terrainAverage, meanUv), smoothstep(.24, .66, footprint));
        result = mix(result, low, smoothstep(.065, .21, footprint));
      }
    }
    return result;
  }

  float terrainFootprint(vec2 uv) {
    return max(length(dFdx(uv)), length(dFdy(uv)));
  }`;

export const terrainFilterShader = uniforms + sampling;

export function addTerrainFilter(shader, textures, rows, water = false) {
  shader.uniforms.terrainRows = {value:rows};
  if (water) {
    shader.uniforms.terrainWater = {value:textures.water};
    shader.fragmentShader = `uniform sampler2D terrainWater; uniform float terrainRows;\n` +
      shader.fragmentShader.replace('#include <map_fragment>', `
        vec2 waterUv = vMapUv * vec2(64.0, terrainRows);
        diffuseColor *= texture2D(terrainWater, waterUv);`);
    return;
  }
  shader.uniforms.terrainMid = {value:textures.mid};
  shader.uniforms.terrainAverage = {value:textures.average};
  shader.fragmentShader = terrainFilterShader + shader.fragmentShader.replace('#include <map_fragment>', `
    vec2 atlasPosition = vMapUv * vec2(64.0, terrainRows);
    diffuseColor *= terrainSample(map, floor(atlasPosition), fract(atlasPosition), terrainFootprint(atlasPosition));`);
}
