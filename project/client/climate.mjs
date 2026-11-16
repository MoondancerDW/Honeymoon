export class Climate {
  constructor() { this.chunks = new Map(); }

  async load() {
    const reply = await fetch('/generated/weather/biomes.json');
    if (!reply.ok) return;
    this.chunks = readBiomes(await reply.json());
  }

  biomeAt(x,z) {
    x = Math.floor(x);
    z = Math.floor(z);
    const chunk = this.chunks.get(`${x>>4}.${z>>4}`);
    const biome = typeof chunk === 'number' ? chunk : chunk?.[(z&15)*16+(x&15)];
    return biome === 255 ? undefined : biome;
  }

  snowAt(x,y,z) { return taigaSnow(this.biomeAt(x,z),x,y,z); }
}

export function readBiomes({version,chunks}) {
  if (version !== 1 || !Array.isArray(chunks)) throw new Error('Invalid weather biome map');
  const biomes = new Map();
  for (const [x,z,data] of chunks) {
    if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error('Invalid biome chunk coordinates');
    const index = `${x}.${z}`;
    biomes.set(index,Number.isInteger(data) && data>=0 && data<255 ? data : readColumns(data));
  }
  return biomes;
}

function readColumns(data) {
  if (typeof data !== 'string') throw new Error('Invalid biome columns');
  const compressed = data.startsWith('r:');
  const bytes = Uint8Array.from(atob(compressed ? data.slice(2) : data),byte=>byte.charCodeAt(0));
  if (!compressed && bytes.length===256) return bytes;
  if (compressed && bytes.length%2===0) {
    const columns = new Uint8Array(256);
    let offset = 0;
    for (let i=0;i<bytes.length;i+=2) {
      const end = offset+bytes[i+1]+1;
      columns.fill(bytes[i],offset,end);
      offset=end;
    }
    if (offset===256) return columns;
  }
  throw new Error('Invalid biome columns');
}

export function taigaSnow(biome,x,y,z) {
  if (biome !== 5 && biome !== 19 && biome !== 133) return false;
  if (y < 152) return false;
  if (y >= 168) return true;
  const variation = 4.5*Math.sin(x*.021+z*.013)+3*Math.sin(x*.045-z*.027);
  return y >= 160+variation;
}
