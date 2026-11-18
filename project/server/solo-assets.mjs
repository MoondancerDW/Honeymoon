export function soloRegionFile(cx,cz) {
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) return null;
  return `full-world/${Math.floor(cx/32)}.${Math.floor(cz/32)}.bin`;
}
