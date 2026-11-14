const colors = [0xffffff,12608256,11868853,7308529,0xbfbf00,7074048,15812213,0x535353,
  0x939393,34695,6160576,1250240,5187328,558848,10620678,0x1f1f1f];

function rotate(x, y, z, rotation) {
  switch (rotation) {
    case 1: return [x, 1 - y, 1 - z];
    case 2: return [z, x, y];
    case 3: return [1 - z, x, 1 - y];
    case 4: return [y, x, 1 - z];
    case 5: return [1 - y, x, z];
    default: return [x, y, z];
  }
}

function dark(color) {
  const b = color >> 16 & 255, g = color >> 8 & 255, r = color & 255;
  const grey = Math.floor((r + g + b) / 3);
  return [b,g,r].reduce((out, channel) => (out << 8) | Math.floor((channel + 2 * grey) / 5), 0);
}

export function lampBounds(data) {
  const inset = data?.style === 1 ? 0.1875 : 0.125;
  const height = data?.style === 1 ? 0.75 : 0.5;
  const a = rotate(inset, 0, inset, data?.rot);
  const b = rotate(1 - inset, height, 1 - inset, data?.rot);
  return {x0:Math.min(a[0],b[0]), y0:Math.min(a[1],b[1]), z0:Math.min(a[2],b[2]),
    x1:Math.max(a[0],b[0]), y1:Math.max(a[1],b[1]), z1:Math.max(a[2],b[2])};
}

export function redPowerLamp(catalog, data) {
  if (!data) return null;
  const lit = Boolean(data.ps & 1) !== Boolean(data.ps & 2);
  const color = colors[data.color & 15];
  const surfs = catalog.lamps[data.style === 1 ? 1 : 0];
  const surfaces = surfs.filter(surface => lit || surface.group !== 2).map(({group, positions, uv}) => {
    const rotated = [];
    for (let i = 0; i < positions.length; i += 3) {
      rotated.push(...rotate(positions[i], positions[i + 1], positions[i + 2], data.rot));
    }
    return {positions:rotated, uv, mode:group === 2 ? 'glow' : 'cutout',
      tint:group === 0 ? 0xffffff : lit ? color : dark(color), emissive:group !== 0 && lit};
  });
  const collision = [lampBounds(data)];
  return {family:'redpower', surfaces, collision, selection:collision};
}
