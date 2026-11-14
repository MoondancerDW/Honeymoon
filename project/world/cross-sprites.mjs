// The cutout mesh is double-sided; a sprite needs two intersecting quads.
export function crossSpriteCorners({x0, x1, y0, y1, z0, z1, spriteShift}, [x, y, z]) {
  const [dx, dz, tiltX, tiltZ] = spriteShift ?? [0, 0, 0, 0];
  const a = x + x0 + dx, b = x + x1 + dx;
  const c = y + y0, d = y + y1;
  const e = z + z0 + dz, f = z + z1 + dz;
  return [
    [[a, c, e], [b, c, f], [b + tiltX, d, f + tiltZ], [a + tiltX, d, e + tiltZ]],
    [[a, c, f], [b, c, e], [b + tiltX, d, e + tiltZ], [a + tiltX, d, f + tiltZ]],
  ];
}
