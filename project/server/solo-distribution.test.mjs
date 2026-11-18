import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {Writable} from 'node:stream';
import test from 'node:test';
import {buildSoloDistribution} from '../import/solo-distribution.mjs';
import {loadSoloDistribution,soloDistributionManifest,soloDistributionVersion} from './solo-distribution.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const formatHash='a'.repeat(64);
const starterKeys=['-1.-1','-1.0','0.-1','0.0'];
const distantKey='4.4';
const npcTexture='npcs/skins/mob/Пони тест.png';
const audioName='0'.repeat(24)+'.ogg';
const commonAssets=[
  'creative/catalog.json','npcs/original.json','textures/atlas.json','textures/atlas.png',
  'textures/legacy-interface.png','textures/minecart.png','textures/paintings.png',
  'models/biblio.json','models/biblio.png','models/jammy.json','models/jammy.png',
  'models/redpower.json','models/redpower.png','weather/biomes.bin',
];

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'honeymoon-solo-distribution-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const generated=join(directory,'generated');
  async function put(path,content) {
    const file=join(generated,path);
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file,typeof content==='string' ? content : JSON.stringify(content));
  }
  const keys=[...starterKeys,distantKey];
  const coords=keys.map(key=>key.split('.').map(Number));
  const mask=Buffer.alloc(128,255).toString('base64');
  const packHashes=Object.fromEntries(keys.map(key=>[key,hash(key)]));
  for (const key of keys) {
    await put('full-world/'+key+'.bin',key);
    await put('lod/'+key+'.bin','lod');
    await put('lod/'+key+'.outer.bin','outer');
    await put('vista/'+key+'.bin','vista');
  }
  await put('full-world/manifest.json',{version:1,sourceHash:formatHash,hash:formatHash,bounds:[-32,-32,159,159],
    regions:coords.map(point=>[...point,mask]),hashes:packHashes,bytes:keys.reduce((n,key)=>n+key.length,0)});
  await put('lod/manifest.json',{tileChunks:4,maxDistance:32,assetHash:formatHash,regions:coords});
  await put('vista/manifest.json',{version:2,hash:formatHash,regions:coords});
  await put('world/world.json',{schemaVersion:1,chunkPalettes:true,contentHash:formatHash,spawn:[.5,1,.5]});
  await put('world/chunks/0.0.json','not needed');
  await put('state/honeymoon.sqlite','never distributed');
  await put('npcs/private-backup.json','never distributed');
  await put('npcs/models.json',{catalog:[{id:'Pony',capture:'native'}],textures:[npcTexture.slice('npcs/skins'.length)]});
  await put('npcs/Pony.json','{}');
  await put(npcTexture,'png');
  await put('sounds/sounds.json',{sounds:{'music.world':[audioName]}});
  await put('sounds/'+audioName,'ogg');
  await put('npcs/sound/Course theme.ogg','ogg');
  for (const path of commonAssets) await put(path,'{}');
  return {directory,generated,put,packHashes};
}

test('indexes only release assets, including adjacent spawn regions and reusable full-world hashes',async t=>{
  const {generated,put,packHashes}=await fixture(t);
  assert.equal(loadSoloDistribution(generated),null);
  const first=await buildSoloDistribution({generated});
  assert.equal(first.build,4);
  assert.equal(first.schema,1);
  assert.equal(first.version,soloDistributionVersion(first));
  assert.ok(first.initial.includes('world/world.json'));
  assert.ok(first.initial.includes('npcs/original.json'));
  for (const key of starterKeys) {
    const path='full-world/'+key+'.bin';
    assert.ok(first.initial.includes(path),path);
    assert.deepEqual(first.files[path],{size:key.length,sha256:packHashes[key]});
  }
  assert.ok(!first.initial.includes('full-world/'+distantKey+'.bin'));
  assert.ok(Object.hasOwn(first.files,npcTexture));
  assert.ok(Object.hasOwn(first.files,'npcs/sound/Course theme.ogg'));
  assert.ok(!first.initial.includes('npcs/sound/Course theme.ogg'));
  assert.ok(!Object.hasOwn(first.files,'world/chunks/0.0.json'));
  assert.ok(!Object.hasOwn(first.files,'state/honeymoon.sqlite'));
  assert.ok(!Object.hasOwn(first.files,'npcs/private-backup.json'));
  const nextBuild=await buildSoloDistribution({generated,build:5});
  assert.equal(nextBuild.version,first.version);
  assert.equal(nextBuild.build,5);
  await put('textures/atlas.png','new atlas');
  assert.notEqual((await buildSoloDistribution({generated})).version,first.version);
  await put('full-world/'+distantKey+'.bin','wrong byte count');
  await assert.rejects(buildSoloDistribution({generated}),{message:/sizes/});
});

test('serves exact GET and HEAD assets, rejects other versions and mutated files',async t=>{
  const {generated,put,directory}=await fixture(t);
  const manifest=await buildSoloDistribution({generated});
  const distribution=loadSoloDistribution(generated);
  const http=createServer((request,response)=>{
    void distribution.serve(request,response,new URL(request.url,'http://localhost').pathname).then(served=>{
      if (!served) response.writeHead(404).end();
    }).catch(error=>response.destroy(error));
  });
  http.listen(0,'127.0.0.1');
  await once(http,'listening');
  t.after(()=>new Promise((resolve,reject)=>http.close(error=>error?reject(error):resolve())));
  const url='http://127.0.0.1:'+http.address().port;
  const filesPath='/solo-download/files/'+manifest.version+'/';
  const head=await fetch(url+filesPath+'world/world.json',{method:'HEAD',headers:{'Accept-Encoding':'identity'}});
  assert.equal(head.status,200);
  assert.equal(await head.text(),'');
  assert.equal(head.headers.get('content-length'),String(manifest.files['world/world.json'].size));
  assert.match(head.headers.get('cache-control'),/immutable/);
  const compressed=await fetch(url+filesPath+'world/world.json',{headers:{'Accept-Encoding':'gzip'}});
  assert.equal(compressed.headers.get('content-encoding'),'gzip');
  assert.equal(compressed.headers.get('vary'),'Accept-Encoding');
  assert.ok(Number(compressed.headers.get('content-length'))<manifest.files['world/world.json'].size);
  assert.equal(hash(Buffer.from(await compressed.arrayBuffer())),manifest.files['world/world.json'].sha256);
  const rejectedEncoding=await fetch(url+filesPath+'world/world.json',{method:'HEAD',headers:{'Accept-Encoding':'gzip;q=0'}});
  assert.equal(rejectedEncoding.headers.get('content-encoding'),null);
  const fetched=await fetch(url+'/solo-download/manifest.json');
  assert.equal(fetched.headers.get('cache-control'),'no-cache');
  assert.deepEqual(await fetched.json(),JSON.parse(await readFile(join(generated,soloDistributionManifest),'utf8')));
  const encodedPath=npcTexture.split('/').map(encodeURIComponent).join('/');
  assert.equal(await (await fetch(url+filesPath+encodedPath)).text(),'png');
  const attempts=[
    [url+filesPath+'state/honeymoon.sqlite','GET'],
    [url+filesPath+'npcs%2fmodels.json','GET'],
    [url+filesPath+'../world/world.json','GET'],
    [url+filesPath+'world/world.json','POST'],
    [url+'/solo-download/files/'+'f'.repeat(64)+'/world/world.json','GET'],
  ];
  for (const [path,method] of attempts) assert.equal((await fetch(path,{method})).status,404);
  await put('world/world.json','modified out of band');
  assert.equal((await fetch(url+filesPath+'world/world.json')).status,404);

  const outside=join(directory,'external-textures');
  await rename(join(generated,'textures'),outside);
  await symlink(outside,join(generated,'textures'),'junction');
  assert.equal((await fetch(url+filesPath+'textures/atlas.png')).status,404);
});

test('limits parallel file bodies, leaving metadata available',async t=>{
  const {generated}=await fixture(t);
  const manifest=await buildSoloDistribution({generated});
  const {serve}=loadSoloDistribution(generated);
  const prefix='/solo-download/files/'+manifest.version+'/textures/';
  const blocks=[];
  function response(hold=false) {
    const stream=new Writable({
      write(_data,_encoding,complete) {
        if (hold) {
          blocks.push(complete);
          this.emit('body-held');
        } else complete();
      },
    });
    stream.writeHead=(status,headers)=>{ Object.assign(stream,{status,headers,headersSent:true}); };
    return stream;
  }
  const active=Array.from({length:4},()=>response(true));
  const begun=active.map(stream=>once(stream,'body-held'));
  const downloads=active.map(stream=>serve({method:'GET'},stream,prefix+'atlas.png'));
  try {
    await Promise.all(begun);
    const extra=response();
    assert.equal(await serve({method:'GET'},extra,prefix+'atlas.png'),true);
    assert.equal(extra.status,503);
    assert.equal(extra.headers['Retry-After'],'2');
    const head=response();
    assert.equal(await serve({method:'HEAD'},head,prefix+'atlas.png'),true);
    assert.equal(head.status,200);
    const catalog=response();
    assert.equal(await serve({method:'GET'},catalog,'/solo-download/manifest.json'),true);
    assert.equal(catalog.status,200);
  } finally {
    blocks.forEach(resume=>resume());
    await Promise.all(downloads);
  }
});
