export const FULL_DETAIL_VERSION = 1;
export const DETAIL_INDEX_OFFSET = 8;
export const DETAIL_INDEX_SIZE = 32*32*8;
export const DETAIL_HEADER_SIZE = DETAIL_INDEX_OFFSET+DETAIL_INDEX_SIZE;
export const detailSlot = (x,z)=>(x&31)+32*(z&31);

export function detailCoverage(descriptor) {
  const regions = new Map();
  if (descriptor?.version === FULL_DETAIL_VERSION) for (const [x,z,base64] of descriptor.regions) {
    const mask = Uint8Array.from(atob(base64),byte=>byte.charCodeAt(0));
    if (mask.length === 128) regions.set(`${x>>0},${z>>0}`,mask);
  }
  return (x,z) => {
    const mask=regions.get(`${x>>5},${z>>5}`);
    const slot=detailSlot(x,z);
    return Boolean(mask && (mask[slot>>3] & (1<<(slot&7))));
  };
}
