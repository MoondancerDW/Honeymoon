import * as THREE from '/vendor/three/three.module.js';
import {loadNpcModelManifest, npcSkinUrl} from '../world/npc-model-catalog.mjs';
import {npcNameVisible} from '../world/npc-editor-wand.mjs';
import {createPonyAvatar} from './pony-avatar.mjs';
import {createPonyHeldItem} from './pony-held-item.mjs';

const modelGeometry=new Map(), textures=new Map();
const textureLoader=new THREE.TextureLoader();
const pixelMeshMaterial={alphaTest:.24,side:THREE.DoubleSide,toneMapped:false};
const renderModeTime={walk:.76,fly:.9,idle:1.65,dance:1.25,attack:.6};
const maxScale=5;
const radiansPerDegree=Math.PI/180;
const browserSize=(value,fallback)=>Math.max(24,Math.min(440,value||fallback));
const vector=(value,target)=>Array.isArray(value) ? target.fromArray(value) : target.set(value.x,value.y,value.z);
const stackAppearance=stack=>stack?.part ? {kind:'block',key:stack.key,part:stack.part} :
  stack?.cell ? {kind:'block',key:stack.cell} :
  stack?.key?.startsWith('creative:768:') ? {kind:'block',key:stack.key} :
  stack?.key?.startsWith('creative:') ? {kind:'item',key:stack.key.slice(9)} :
  {kind:'block',key:stack?.key??'legacy:1:0'};

function onePromise(cache,key,load) {
  if(!cache.has(key)) cache.set(key,load().catch(error=>{cache.delete(key);throw error;}));
  return cache.get(key);
}

async function skinFor(model,requested) {
  const {catalog,textures:paths}=await loadNpcModelManifest();
  const defaultTexture=catalog.find(row=>row.id===model)?.defaultTexture??'/mob/char.png';
  const path=paths.includes(requested)?requested:
    typeof requested==='string' ? paths.find(path=>path.toLowerCase()===requested.toLowerCase())??defaultTexture : defaultTexture;
  return npcSkinUrl(path);
}

const getTexture=url=>onePromise(textures,url,async()=>{
  const texture=await textureLoader.loadAsync(url);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.magFilter=THREE.NearestFilter;
  texture.minFilter=THREE.NearestMipmapLinearFilter;
  return texture;
});

function poseTransform(data) {
  const m=new THREE.Matrix4().set(
    data[1],data[4],data[7],data[10],data[2],data[5],data[8],data[11],
    data[3],data[6],data[9],data[12],0,0,0,1);
  const position=new THREE.Vector3(), rotation=new THREE.Quaternion(), scale=new THREE.Vector3();
  m.decompose(position,rotation,scale);
  return {position,rotation,scale,matrix:m};
}

function makeRig({meshes,clips}) {
  const idle=clips?.idle?.[0];
  if(!idle?.length) throw new Error('Missing NPC resting pose');
  // Renderers may draw the same articulated part more than once, for example the dragon spine.
  const parts=idle.map(row=>row[0]);
  const groups=[], lookup=new Map();
  for(let i=0;i<parts.length;i++) {
    const key=parts[i], occurrence=lookup.get(key)??0;
    groups[i]=key+':'+occurrence;
    lookup.set(key,occurrence+1);
  }
  const captured={};
  const rest=idle.map(poseTransform);
  for(const [name,frames] of Object.entries(clips)) captured[name]=frames.map(frame=>{
    const instances=new Map(), counts=new Map();
    for(const row of frame) {
      const id=row[0], occurrence=counts.get(id)??0;
      instances.set(id+':'+occurrence,poseTransform(row));
      counts.set(id,occurrence+1);
    }
    return groups.map((key,i)=>instances.get(key)??rest[i]);
  });
  const opaque={positions:[],uvs:[],bones:[],weights:[],indices:[]};
  const blended={positions:[],uvs:[],bones:[],weights:[],indices:[]};
  const bounds=new THREE.Box3(), point=new THREE.Vector3();
  for(let i=0;i<parts.length;i++) {
    const uvQuad=meshes[parts[i]]?.[1]??[];
    const target=idle[i].at(-1)<.999 ? blended : opaque;
    for(let v=0;v+19<uvQuad.length;v+=20) {
      const start=target.positions.length/3;
      for(let j=v;j<v+20;j+=5) {
        const [x,y,z,u,t]=uvQuad.slice(j,j+5);
        target.positions.push(x,y,z);
        target.uvs.push(u,1-t);
        target.bones.push(i,0,0,0);
        target.weights.push(1,0,0,0);
        bounds.expandByPoint(point.set(x,y,z).applyMatrix4(rest[i].matrix));
      }
      target.indices.push(start,start+1,start+2,start,start+2,start+3);
    }
  }
  const width=bounds.max.x-bounds.min.x, height=bounds.max.y-bounds.min.y, depth=bounds.max.z-bounds.min.z;
  if(![width,height,depth].every(Number.isFinite)) throw new Error('Invalid NPC model extents');
  function buffer({positions,uvs,bones,weights,indices}) {
    if(!positions.length) return null;
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(bones,4));
    geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
    geometry.setIndex(indices);
    return geometry;
  }
  const named=parts.map(part=>meshes[part]?.[0]??'');
  const hand=named.findIndex(name=>/^(biped)?rightarm$/i.test(name));
  const head=named.flatMap((name,index)=>/head|muzzle|ears/i.test(name)?[index]:[]);
  return {opaque:buffer(opaque),blended:buffer(blended),clips:captured,rest,ground:bounds.max.y,
    width,height,depth,parts:parts.length,hand,head};
}

function getModel(id) {
  return onePromise(modelGeometry,id,async()=>{
    const {catalog}=await loadNpcModelManifest();
    if(!catalog.some(model=>model.id===id)) throw new RangeError('Unknown NPC model '+id);
    const response=await fetch('/generated/npcs/'+encodeURIComponent(id)+'.json');
    if(!response.ok) throw new Error('NPC model asset is unavailable');
    return makeRig(await response.json());
  });
}

function lightColor(materials,color) {
  if(!Number.isInteger(color)) return;
  for(const material of materials) material.color.setHex(color);
}

async function makeModel(npc,itemAssets) {
  const id=npc.model??'npcpony';
  if(id==='item') {
    const item=createPonyHeldItem();
    item.object.position.y=.54;
    item.object.scale.setScalar(.68);
    item.show(stackAppearance(npc.item),itemAssets,null);
    return {...item,height:1,width:.85,depth:.85,
      animate({time,moving}) {
        item.object.position.y=.52+Math.sin(time*2.2)*.048;
        if(moving) item.object.rotation.y=time*.8;
      }};
  }
  const textureUrl=await skinFor(id,npc.texture);
  if(id==='npcpony') {
    const pony=createPonyAvatar();
    await pony.setSkin(textureUrl);
    let dance;
    return {...pony,height:1.45,width:1,depth:1.12,
      animate({time,dt,moving,animation,pitch,headYaw,position,held,equipment}) {
        const motion=animation==='fly'?'fly':animation==='sit'?'sit':moving?'walk':'idle';
        dance=animation==='dance'?(dance??{id:'dance',started:Date.now()}):undefined;
        pony.animate({time,dt,speed:moving?2.9:0,motion,pitch:-(pitch??0),yawOffset:headYaw,
          stance:animation==='crawl'?'crawl':animation==='sneak'?'crouch':'stand',
          groundSeat:animation==='sit',position,swing:animation==='attack'?Math.floor(time*2):0,
          held,equipment,itemAssets,emote:dance});
        pony.object.rotation.z=animation==='dead'?-Math.PI/2:animation==='hurt'?-.12:0;
      }};
  }
  const [model,texture]=await Promise.all([getModel(id),getTexture(textureUrl)]);
  const object=new THREE.Group(), actor=new THREE.Group(), bones=[];
  // Coordinate system used by the original renderer: Y down, then X and Y flipped.
  actor.scale.set(-1,-1,1);
  actor.position.y=model.ground;
  object.add(actor);
  for(let i=0;i<model.parts;i++) {
    const bone=new THREE.Bone();
    actor.add(bone);
    bones.push(bone);
  }
  const skeleton=new THREE.Skeleton(bones,bones.map(()=>new THREE.Matrix4()));
  const materials=[];
  for(const [geometry,transparent] of [[model.opaque,false],[model.blended,true]]) {
    if(!geometry) continue;
    const material=new THREE.MeshBasicMaterial({...pixelMeshMaterial,map:texture,transparent,opacity:transparent?.58:1,
      depthWrite:!transparent,alphaToCoverage:!transparent});
    materials.push(material);
    const mesh=new THREE.SkinnedMesh(geometry,material);
    mesh.frustumCulled=false;
    actor.add(mesh);
    mesh.bind(skeleton,new THREE.Matrix4());
  }

  const headTurn=new THREE.Euler(0,0,0,'YXZ'), turn=new THREE.Quaternion();
  let prop;
  function showProp(held) {
    if(model.hand<0) return;
    if(!held) {
      if(prop) prop.object.visible=false;
      return;
    }
    if(!prop) {
      prop=createPonyHeldItem();
      prop.object.position.set(-.6,7,1.15);
      prop.object.rotation.x=Math.PI/2;
      prop.object.scale.setScalar(6.3);
      bones[model.hand].add(prop.object);
    }
    prop.show(held,itemAssets,null);
    prop.grip(true);
  }
  function setPose(left,right,alpha) {
    for(let i=0;i<bones.length;i++) {
      const a=left[i],b=right[i],bone=bones[i];
      bone.position.lerpVectors(a.position,b.position,alpha);
      bone.quaternion.slerpQuaternions(a.rotation,b.rotation,alpha);
      bone.scale.lerpVectors(a.scale,b.scale,alpha);
    }
  }
  setPose(model.rest,model.rest,0);
  return {object,height:model.height,width:model.width,depth:model.depth,
    setLight(color) {lightColor(materials,color);prop?.setLight(color);},
    animate({time,moving,animation,pitch=0,headYaw=0,held}) {
      const mode=moving && animation==='idle' ? 'walk' : animation;
      const clip=model.clips[mode]??model.clips.idle;
      const sample=((time/(renderModeTime[mode]??1.5))%1+1)%1*clip.length;
      const left=Math.floor(sample),alpha=sample-left;
      setPose(clip[left],clip[(left+1)%clip.length],alpha);
      if(pitch || headYaw) {
        headTurn.set(THREE.MathUtils.clamp(-pitch,-.8,.8),-headYaw,0);
        turn.setFromEuler(headTurn);
        for(const i of model.head) bones[i].quaternion.multiply(turn);
      }
      showProp(held);
      if(['NpcSlime','Slime','LavaSlime'].includes(id)) {
        const squish=moving ? .16*Math.cos(time*9.5) : .035*Math.cos(time*2.8);
        actor.scale.set(-1-squish,-1/(1+squish),1+squish);
      }
      object.rotation.z=animation==='dead'?-Math.PI/2:animation==='hurt'?-.12:0;
    },
    dispose() {
      object.removeFromParent();
      prop?.dispose();
      skeleton.dispose();
      for(const material of materials) material.dispose();
    }};
}

function nameplate(name,title) {
  const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d');
  ctx.font='bold 18px monospace';
  canvas.width=Math.max(32,Math.min(500,Math.ceil(Math.max(ctx.measureText(name).width,ctx.measureText(title).width))+12));
  canvas.height=title?43:25;
  ctx.fillStyle='rgba(16,23,30,.57)';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.textAlign='center';
  ctx.font='bold 18px monospace';
  ctx.fillStyle='#fff';
  ctx.fillText(name,canvas.width/2,18,canvas.width-8);
  if(title) {
    ctx.font='14px monospace';
    ctx.fillStyle='#f3d79d';
    ctx.fillText(title,canvas.width/2,35,canvas.width-8);
  }
  const map=new THREE.CanvasTexture(canvas);
  map.colorSpace=THREE.SRGBColorSpace;
  map.generateMipmaps=false;
  map.minFilter=map.magFilter=THREE.NearestFilter;
  const icon=new THREE.Sprite(new THREE.SpriteMaterial({map,transparent:true,depthWrite:false,toneMapped:false}));
  icon.scale.set(canvas.width/115,canvas.height/115,1);
  return icon;
}

function removeLabel(row) {
  if(!row.label) return;
  row.label.removeFromParent();
  row.label.material.map.dispose();
  row.label.material.dispose();
  row.label=null;
}
const signature=npc=>JSON.stringify([npc.model,npc.texture,npc.item]);
const angleMix=(a,b,f)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*f;
const spinningYaw=(yaw,rate,elapsed)=>(yaw??0)+(rate??0)*radiansPerDegree*Math.max(0,elapsed)*.001;

function setNpcState(row,npc,now) {
  if (row.yawAt===undefined || row.npc.yaw!==npc.yaw || row.npc.spinSpeed!==npc.spinSpeed) row.yawAt=now;
  row.npc=npc;
}

export class NpcView {
  constructor(scene, camera, itemAssets, {mobile=false, chunkVisible=()=>true, light=()=>0xffffff}={}) {
    this.scene=scene;
    this.camera=camera;
    this.itemAssets=itemAssets;
    this.entries=new Map();
    this.maximum=mobile?20:42;
    this.distance=mobile?36:64;
    this.materialized=[];
    this.mobile=mobile;
    this.chunkVisible=chunkVisible;
    this.light=light;
    this.clip=new THREE.Frustum();
    this.sphere=new THREE.Sphere();
    this.clipMatrix=new THREE.Matrix4();
    this.lastPick=0;
    this.previews=new WeakMap();
    this.pickRay=new THREE.Ray();
    this.pickBounds=new THREE.Box3();
    this.temp=new THREE.Vector3();
  }

  setRevealHiddenNames(enabled) {
    this.revealHiddenNames=Boolean(enabled);
  }

  nameVisible(npc) {
    return npcNameVisible(npc,this.revealHiddenNames);
  }

  replace(list,now=performance.now()) {
    if(!Array.isArray(list)) return;
    const present=new Set();
    for(const npc of list) {
      if(!npc?.id || !npc.position || !Number.isFinite(npc.position.x) ||
          !Number.isFinite(npc.position.y) || !Number.isFinite(npc.position.z)) continue;
      present.add(npc.id);
      let row=this.entries.get(npc.id);
      const key=signature(npc);
      if(!row) {
        const object=new THREE.Group(), target=vector(npc.position,new THREE.Vector3());
        object.position.copy(target);
        object.rotation.y=npc.yaw??0;
        object.visible=false;
        this.scene.add(object);
        row={object,target,npc,key,actor:null,label:null,pending:0,headYaw:npc.headYaw??0};
        this.entries.set(npc.id,row);
      }
      if(row.key!==key) {
        row.actor?.dispose();
        row.actor=null;
        row.pending=0;
        row.key=key;
      }
      if(row.npc.name!==npc.name || row.npc.title!==npc.title || row.npc.showName!==npc.showName) removeLabel(row);
      setNpcState(row,npc,now);
      vector(npc.position,row.target);
      if(row.object.position.distanceToSquared(row.target)>64) row.object.position.copy(row.target);
      row.object.scale.setScalar(THREE.MathUtils.clamp(Number(npc.scale)||1,.05,maxScale));
    }
    for(const [id,row] of this.entries) if(!present.has(id)) {
      row.actor?.dispose();
      removeLabel(row);
      row.object.removeFromParent();
      this.entries.delete(id);
    }
  }

  motion(list,now=performance.now()) {
    if(!Array.isArray(list)) return;
    for(const npc of list) {
      const row=this.entries.get(npc.id);
      if(!row) continue;
      setNpcState(row,{...row.npc,...npc},now);
      if(npc.position) vector(npc.position,row.target);
      if(row.object.position.distanceToSquared(row.target)>64) row.object.position.copy(row.target);
    }
  }

  prime(row,now) {
    const assets=this.itemAssets();
    if(!assets||row.actor||row.pending||row.retry>now) return;
    const creating=row.pending=now||1;
    void makeModel(row.npc,assets).then(model=>{
      if(row.pending!==creating||!this.entries.has(row.npc.id)) return model.dispose();
      row.pending=0;
      row.actor=model;
      row.object.add(model.object);
    }).catch(()=>{
      if(row.pending!==creating) return;
      row.pending=0;
      row.retry=performance.now()+3500;
    });
  }

  update(now,dt) {
    if(!this.entries.size) return;
    const eye=this.camera.position;
    if(now-this.lastPick>85 || !this.materialized.length) {
      this.lastPick=now;
      this.camera.updateMatrixWorld();
      this.clip.setFromProjectionMatrix(this.clipMatrix.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse));
      const candidates=[];
      for(const row of this.entries.values()) {
        const {target,object,actor}=row, scale=object.scale.x;
        const distance=target.distanceToSquared(eye);
        object.visible=false;
        if(distance>this.distance**2 || !this.chunkVisible(Math.floor(target.x)>>4,Math.floor(target.z)>>4)) continue;
        this.sphere.center.copy(target);
        this.sphere.center.y+=(actor?.height??1.5)*scale*.6;
        this.sphere.radius=Math.max(actor?.height??1.8,actor?.width??1.1,actor?.depth??1.1)*scale;
        if(distance>25&&!this.clip.intersectsSphere(this.sphere)) continue;
        candidates.push({row,distance});
      }
      candidates.sort((a,b)=>a.distance-b.distance);
      this.materialized=candidates.slice(0,this.maximum).map(({row})=>row);
    }
    for(const row of this.materialized) {
      const {npc,actor,object,target}=row;
      if(!this.entries.has(npc.id)) continue;
      if(!actor) {this.prime(row,now);continue;}
      object.visible=true;
      const gain=1-Math.exp(-Math.max(.002,dt)*11);
      object.position.lerp(target,gain);
      const yaw=spinningYaw(npc.yaw,npc.spinSpeed,now-row.yawAt);
      object.rotation.y=row.lastAnimation ? angleMix(object.rotation.y,yaw,gain) : yaw;
      row.headYaw=THREE.MathUtils.lerp(row.headYaw,npc.headYaw??0,gain);
      const distance=object.position.distanceToSquared(eye);
      if(!this.mobile || distance<144 || !row.lastAnimation || now-row.lastAnimation>=55) {
        const elapsed=row.lastAnimation?Math.min(.1,(now-row.lastAnimation)*.001):dt;
        row.lastAnimation=now;
        actor.animate({...npc,headYaw:row.headYaw,time:now*.001,dt:elapsed,position:object.position});
        actor.setLight(this.light(target.x,target.y+.8,target.z));
      }
      const labeled=this.nameVisible(npc) && npc.name && distance<34**2;
      if(labeled&&!row.label) {
        row.label=nameplate(npc.name,npc.title??'');
        row.label.position.y=actor.height+.18;
        // Keep labels readable when an NPC is resized.
        row.label.scale.divideScalar(object.scale.x);
        object.add(row.label);
      }
      if(row.label) row.label.visible=Boolean(labeled);
      // The world scene skips automatic matrix traversal.
      object.updateMatrixWorld(true);
    }
  }

  pick(origin,direction,reach=6) {
    if(!origin||!direction) return null;
    vector(origin,this.pickRay.origin);
    vector(direction,this.pickRay.direction).normalize();
    let hit=null;
    for(const row of this.materialized) {
      if(!row.object.visible||!row.actor||row.npc.animation==='dead') continue;
      const {position,scale}=row.object;
      const half=Math.max(.29,row.actor.width*.52,row.actor.depth*.45)*scale.x;
      this.pickBounds.min.set(position.x-half,position.y-.14,position.z-half);
      this.pickBounds.max.set(position.x+half,position.y+Math.max(.44,row.actor.height*scale.x),position.z+half);
      const point=this.pickRay.intersectBox(this.pickBounds,this.temp);
      if(!point) continue;
      const distance=this.pickRay.origin.distanceTo(point);
      if(distance>reach||hit&&hit.distance<=distance) continue;
      hit={id:row.npc.id,entity:row.npc,distance,point:point.clone().toArray()};
    }
    return hit;
  }

  async preview(canvas,appearance,now=performance.now()) {
    const itemAssets=this.itemAssets();
    if(!canvas||!itemAssets) return false;
    const key=signature(appearance);
    let session=this.previews.get(canvas);
    if(session?.key!==key) {
      this.clearPreview(canvas);
      session={key,pending:makeModel(appearance,itemAssets),lastTime:0,started:now};
      this.previews.set(canvas,session);
    }
    try {
      const model=await session.pending;
      if(this.previews.get(canvas)!==session) return false;
      if(!this.previewRenderer) {
        this.previewRenderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
        this.previewRenderer.setClearColor(0,0);
      }
      const width=browserSize(canvas.clientWidth,canvas.width||240);
      const height=browserSize(canvas.clientHeight,canvas.height||200);
      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(34,width/height,.01,100);
      const radius=Math.max(.7,model.height,model.width,model.depth);
      const rate=appearance.rotation==='spin' ? appearance.spinSpeed||45 : 0;
      model.object.rotation.y=.62+spinningYaw(appearance.yaw,rate,now-session.started);
      camera.position.set(radius*.14,model.height*.68,-radius*2.2);
      camera.lookAt(0,model.height*.53,0);
      scene.add(model.object);
      const dt=session.lastTime?Math.min(.1,(now-session.lastTime)*.001):.05;
      session.lastTime=now;
      model.animate({...appearance,time:now*.001,dt,position:{x:0,y:0,z:0}});
      model.setLight(0xffffff);
      this.previewRenderer.setSize(width,height,false);
      this.previewRenderer.render(scene,camera);
      canvas.width=width;
      canvas.height=height;
      const context=canvas.getContext('2d');
      context.clearRect(0,0,width,height);
      context.drawImage(this.previewRenderer.domElement,0,0);
      return true;
    } catch {
      if(this.previews.get(canvas)===session) this.clearPreview(canvas);
      return false;
    }
  }

  clearPreview(canvas) {
    const session=this.previews.get(canvas);
    if(!session) return;
    this.previews.delete(canvas);
    session.pending.then(model=>model.dispose(),()=>{});
  }

  inspect() {
    return {received:this.entries.size,rendered:this.materialized.filter(row=>row.object.visible).length,
      ready:this.materialized.filter(row=>row.actor).length,models:modelGeometry.size};
  }
}
