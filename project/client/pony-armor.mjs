import * as THREE from '/vendor/three/three.module.js';
import {ponyArmorModel} from '../world/pony-armor-data.mjs';
import {ponyAccessory,ponyArmor,ponyArmorFamilies} from '../world/pony-armor.mjs';

const native = ponyArmorModel.native;
const layers = [
  [['head',['head','ear.0','ear.1']]],
  [['body',['saddle']], [0,['frontRight.top']], [1,['frontLeft.top']]],
  [['body',['saddle']], [2,['hindRight.ext','hindRight.extJoint']], [3,['hindLeft.ext','hindLeft.extJoint']]],
  [[0,['frontRight']], [1,['frontLeft']], [2,['hindRight.ext']], [3,['hindLeft.ext']]],
];
const scale = 1/16;
let texture, ready, accessoriesReady;
const cached = new Map();

function armorTextureReady() {
  if (!ready) {
    ready = new Promise(resolve => {
      texture = new THREE.TextureLoader().load('/generated/textures/pony-armor.png',resolve,undefined,()=>resolve(null));
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
    });
  }
  return ready;
}

function accessoryAssets() {
  return accessoriesReady ??= fetch('/generated/models/biblio.json').then(response=>{
    if (!response.ok) throw new Error('Accessory sprites unavailable');
    return response.json();
  }).then(async ({items,armor})=>{
    const map=await new THREE.TextureLoader().loadAsync('/generated/models/biblio.png');
    map.flipY=false;
    map.colorSpace=THREE.SRGBColorSpace;
    map.magFilter=map.minFilter=THREE.NearestFilter;
    map.generateMipmaps=false;
    map.needsUpdate=true;
    return {items,armor,map};
  }).catch(()=>null);
}

export function equipmentTextureReady(equipment=[]) {
  return Promise.all([
    equipment.some(stack=>ponyArmor(stack?.key)) && armorTextureReady(),
    equipment.some(stack=>ponyAccessory(stack?.key)) && accessoryAssets(),
  ]);
}

const accessoryTransforms = {
  hat:{anchor:'head',width:.64,height:.64,y:-.36,z:-.383},
  face:{anchor:'head',width:.59,height:.54,y:-.1,z:-.39},
  neck:{anchor:'neck',width:.34,height:.34,y:.22,z:-.215},
  body:{anchor:'body',width:.50,height:.55,y:.45,z:.115},
};

function accessoryGeometry(accessory,assets) {
  const captured=assets.armor?.[`${accessory.id}:16777215`];
  if (accessory.placement==='hat' && captured?.length) {
    const positions=[], uv=[], indices=[];
    for (const face of captured) {
      const start=positions.length/3;
      for (let offset=0;offset<face.positions.length;offset+=3) {
        const [x,y,z]=face.positions.slice(offset,offset+3);
        positions.push(x-.5,1.72-y,z-.61);
      }
      uv.push(...face.uv);
      indices.push(start,start+1,start+2,start,start+2,start+3);
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geometry.setIndex(indices);
    return geometry;
  }
  const source=assets.items?.[`${accessory.id}:0`]?.uv;
  if (!source) return null;
  const [u0,v0,u1,v1]=source;
  const {width,height,y,z}=accessoryTransforms[accessory.placement];
  const geometry=new THREE.PlaneGeometry(width,height);
  const uv=geometry.attributes.uv;
  for (let vertex=0;vertex<uv.count;vertex++) {
    uv.setXY(vertex,u0+(u1-u0)*uv.getX(vertex),v0+(v1-v0)*uv.getY(vertex));
  }
  geometry.translate(0,y,z);
  return geometry;
}

function armorGeometry(row,slot,names) {
  const cacheKey = `${row}:${slot}:${names.join(',')}`;
  if (cached.has(cacheKey)) return cached.get(cacheKey);
  const positions = [], uvs = [], colors = [], indices = [];
  const proneLeg = names.some(name => name.toLowerCase().endsWith('joint')) ? [] : null;
  const origin = native[names[0]][0];
  const uOffset = slot === 2 ? .5 : 0;
  const rows = ponyArmorFamilies.length;
  const vec = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const name of names) {
    const [[x,y,z,rx,ry,rz],quads] = native[name];
    const rotation = new THREE.Euler(rx,ry,rz,'ZYX');
    for (let index=0;index<quads.length;index+=20) {
      const quad = quads.slice(index,index+20);
      vec.fromArray(quad);
      a.fromArray(quad,5).sub(vec);
      b.fromArray(quad,10).sub(vec);
      const normal = a.cross(b).normalize();
      const shade = .8 + .17 * Math.max(0,-normal.y) + .08 * Math.abs(normal.z);
      const u = (quad[3]+quad[8]+quad[13]+quad[18])/4;
      const v = (quad[4]+quad[9]+quad[14]+quad[19])/4;
      const base = positions.length/3;
      for (let offset=0;offset<20;offset+=5) {
        vec.fromArray(quad,offset).applyEuler(rotation);
        if (name === 'saddle' && slot === 2) {
          vec.x *= .984;
          vec.y = 8 + (vec.y - 8) * .984;
          vec.z = 6 + (vec.z - 6) * .984;
        }
        if (name.endsWith('.top')) {
          // The reference's shoulder plates are posed from the upper-arm pivot.
          vec.x += name.startsWith('frontRight') ? -8 : 8;
          vec.z -= 1;
        }
        positions.push((vec.x+x-origin[0])*scale,(vec.y+y-origin[1])*scale,(vec.z+z-origin[2])*scale);
        if (proneLeg) proneLeg.push(0,0,name.toLowerCase().endsWith('joint') ? scale : 0);
        // Stay within each face's pixels before moving into the armor atlas.
        const su = quad[offset+3]+Math.sign(u-quad[offset+3])*.002;
        const sv = quad[offset+4]+Math.sign(v-quad[offset+4])*.004;
        uvs.push(uOffset+su*.5,(row+sv)/rows);
        colors.push(shade,shade,shade);
      }
      indices.push(base,base+1,base+2,base,base+2,base+3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  if (proneLeg) {
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(proneLeg,3)];
    geometry.morphTargetsRelative = true;
  }
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  cached.set(cacheKey,geometry);
  return geometry;
}

export function createPonyArmor(rig) {
  const parts = layers.map(()=>({key:null,meshes:[],material:null,accessoryGeometry:null,pending:null}));
  let armorLight = 0xffffff;

  function clear(part) {
    for (const mesh of part.meshes) mesh.removeFromParent();
    part.material?.dispose();
    part.accessoryGeometry?.dispose();
    part.accessoryGeometry=null;
    part.pending=null;
    part.material = null;
    part.meshes.length = 0;
  }

  return {
    update(equipment) {
      for (let slot=0;slot<parts.length;slot++) {
        const part = parts[slot];
        const key = equipment?.[slot]?.key ?? null;
        if (part.key === key) continue;
        part.key = key;
        clear(part);
        const accessory=ponyAccessory(key);
        if (accessory?.slot===slot) {
          const pending=Symbol();
          part.pending=pending;
          void accessoryAssets().then(assets=>{
            if (!assets || part.pending!==pending) return;
            const geometry=accessoryGeometry(accessory,assets);
            if (!geometry) return;
            const material=new THREE.MeshBasicMaterial({map:assets.map,color:armorLight,
              alphaTest:.4,alphaToCoverage:true,side:THREE.DoubleSide});
            const mesh=new THREE.Mesh(geometry,material);
            rig[accessoryTransforms[accessory.placement].anchor].add(mesh);
            part.accessoryGeometry=geometry;
            part.material=material;
            part.meshes.push(mesh);
          });
          continue;
        }
        const armor = ponyArmor(key);
        if (armor?.slot !== slot) continue;
        const row = ponyArmorFamilies.indexOf(armor.material);
        armorTextureReady();
        const material = new THREE.MeshBasicMaterial({
          map:texture, color:armorLight, alphaTest:.4, alphaToCoverage:true, vertexColors:true, side:THREE.DoubleSide,
        });
        part.material = material;
        for (const [anchor,names] of layers[slot]) {
          const parent = typeof anchor === 'number' ? rig.legs[anchor] : rig[anchor];
          const mesh = new THREE.Mesh(armorGeometry(row,slot,names),material);
          parent.add(mesh);
          part.meshes.push(mesh);
        }
      }
      for (const mesh of parts[2].meshes) {
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = mesh.parent.morphTargetInfluences[0];
      }
    },
    setLight(color) {
      armorLight = color;
      for (const {material} of parts) material?.color.set(color);
    },
    inspect() { return parts.map(part=>({key:part.key,meshes:part.meshes.length})); },
    dispose() { parts.forEach(clear); },
  };
}
