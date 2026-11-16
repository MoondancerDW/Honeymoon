const colors = [
  [0x8eb971,0x71a74d], [0x91bd59,0x77ab2f], [0xbfb755,0xaea42a], [0x8ab689,0x6da36b],
  [0x79c05a,0x59ae30], [0x82b593,0x63a277], [0x6ac44e,0x45b421], [0x8eb971,0x71a74d],
  [0xbfb755,0xaea42a], [0x8eb971,0x71a74d], [0x80b497,0x60a17b], [0x80b497,0x60a17b],
  [0x80b497,0x60a17b], [0x80b497,0x60a17b], [0x55c93f,0x2bbb0f], [0x55c93f,0x2bbb0f],
  [0x91bd59,0x77ab2f], [0xbfb755,0xaea42a], [0x79c05a,0x59ae30], [0x82b593,0x63a277],
  [0x8ab689,0x6da36b], [0x53ca37,0x29bc05], [0x53ca37,0x29bc05],
].map(([grass,leaves])=>Object.freeze({grass,leaves}));
const snowLine = 160;
const mountainBiomes = new Set([3,13,20]);

// These are the active My-Little-Ponyach-147f colormap pixels, addressed by
// the original biome temperature and rain values. The reference disables swamp blending.
export const biomeTint = biome => colors[biome & 127] ?? colors[4];

export function readWorldBiomes(buffer) {
  const view=new DataView(buffer);
  if (view.byteLength<16 || view.getUint32(0)!==0x4842494f) throw new Error('Invalid full-world biome map');
  const version=view.getUint16(4,true);
  if (version!==1 && version!==2) throw new Error('Unknown full-world biome map version');
  const x0=view.getInt16(6,true), z0=view.getInt16(8,true);
  const width=view.getUint16(10,true), depth=view.getUint16(12,true);
  const indexEnd=16+width*depth*4;
  if (!width || !depth || indexEnd>view.byteLength) throw new Error('Invalid full-world biome bounds');
  return (x,z)=>{
    const cx=(x>>4)-x0, cz=(z>>4)-z0;
    if (cx<0 || cz<0 || cx>=width || cz>=depth) return;
    const entry=view.getUint32(16+4*(cz*width+cx),true);
    if (!entry) return;
    if (!(entry&0x80000000)) return entry<=255 ? entry-1 : undefined;
    const offset=entry&0x7fffffff;
    if (offset<indexEnd || offset>=view.byteLength) return;
    const index=(z&15)*16+(x&15);
    const count=version===2 ? view.getUint8(offset) : 0;
    const palette=offset+(version===2 ? 1 : 0);
    let id;
    if (!count) {
      if (palette+256>view.byteLength) return;
      id=view.getUint8(palette+index);
    } else {
      const width=count<=2 ? 1 : count<=4 ? 2 : 4;
      if (count>16 || palette+count+32*width>view.byteLength) return;
      const bit=index*width;
      const color=(view.getUint8(palette+count+(bit>>3))>>(bit&7))&((1<<width)-1);
      if (color>=count) return;
      id=view.getUint8(palette+color);
    }
    return id===255 ? undefined : id;
  };
}

export class Climate {
  constructor() { this.chunks = new Map(); this.columns = new Map(); }

  async load() {
    const full=await fetch('/generated/weather/biomes.bin',{priority:'low'});
    if (full.ok) this.full=readWorldBiomes(await full.arrayBuffer());
    else {
      const reply=await fetch('/generated/weather/biomes.json',{priority:'low'});
      if (!reply.ok) return false;
      this.chunks=readBiomes(await reply.json());
    }
    this.columns.clear();
    return true;
  }

  biomeAt(x,z) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (this.full) return this.full(x,z);
    const chunk = this.chunks.get(`${x>>4}.${z>>4}`);
    const biome = typeof chunk === 'number' ? chunk : chunk?.[(z&15)*16+(x&15)];
    return biome === 255 ? undefined : biome;
  }

  snowAt(x,y,z) { return y>=snowLine || biomeSnow(this.biomeAt(x,z),y); }

  tintAt(x,z) { return biomeTint(this.biomeAt(x,z) ?? 4); }

  columnTints(cx,cz) {
    const key=`${cx}.${cz}`;
    if (!this.columns.has(key)) {
      const result=new Uint32Array(512);
      for (let z=0;z<16;z++) for (let x=0;x<16;x++) {
        const {grass,leaves}=this.tintAt(cx*16+x,cz*16+z);
        const index=(z*16+x)*2;
        result[index]=grass;
        result[index+1]=leaves;
      }
      if (this.columns.size>=128) this.columns.delete(this.columns.keys().next().value);
      this.columns.set(key,result);
    }
    return this.columns.get(key);
  }
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

export const biomeSnow = (biome,y) => y>=snowLine || mountainBiomes.has(biome&127);
