import * as THREE from '/vendor/three/three.module.js';
import {RainCover} from './rain-cover.mjs';
import {blockState} from '../world/block-interactions.mjs';
import {collisionFor,coverBoxes} from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {fluidState,fluidSurface} from '../world/fluid-state.mjs';
import {sampleSnowLane,snowColumnBand,snowCoverage} from './snow-coverage.mjs';

const textureSide=256, textureBlocks=16, duration=60;
const snowBlocks=new Set([78,80]);
const faces=[[0,1,0],[1,0,Math.PI/2],[0,-1,Math.PI],[-1,0,-Math.PI/2]];
const wallOffset=.004;

function variation(x,z,salt=0) {
  let value=Math.imul(x+salt*227,0x1f123bb5)^Math.imul(z+salt*137,0x5f356495);
  value=Math.imul(value^value>>>16,0x7feb352d);
  value=Math.imul(value^value>>>15,0x846ca68b);
  return ((value^value>>>16)>>>0)/0x100000000;
}

function tileNoise(x,z,nx,nz,salt) {
  const gx=x*nx/textureSide,gz=z*nz/textureSide;
  const x0=Math.floor(gx),z0=Math.floor(gz);
  const a=variation(x0,z0,salt), b=variation((x0+1)%nx,z0,salt);
  const c=variation(x0,(z0+1)%nz,salt), d=variation((x0+1)%nx,(z0+1)%nz,salt);
  const u=THREE.MathUtils.smoothstep(gx-x0,0,1),v=THREE.MathUtils.smoothstep(gz-z0,0,1);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a,b,u),THREE.MathUtils.lerp(c,d,u),v);
}

function makeMask(style) {
  const pixels=new Uint8Array(textureSide**2*4);
  const field=new Uint8Array(textureSide**2), histogram=new Uint32Array(256);
  for(let z=0;z<textureSide;z++) for(let x=0;x<textureSide;x++) {
    const i=z*textureSide+x;
    const coarse=tileNoise(x,z,style===2?9:12,style===2?19:12,8);
    const detail=tileNoise(x,z,27,27,16);
    const grain=variation(x,z,4);
    const density=style===1 ? .55*coarse+.26*detail+.19*grain : .71*coarse+.21*detail+.08*grain;
    field[i]=Math.round(density*255);
    histogram[field[i]]++;
  }
  // This puts solid cores on roughly half the surface, with softer broken edges.
  let threshold=0,count=0,covered=0;
  while(count<field.length*.43 && threshold<255) count+=histogram[threshold++];
  for(let z=0;z<textureSide;z++) for(let x=0;x<textureSide;x++) {
    const i=z*textureSide+x,offset=4*i,light=variation(x,z,8);
    const alpha=THREE.MathUtils.smoothstep(field[i],threshold-12,threshold+13);
    pixels[offset]=228+light*24;pixels[offset+1]=238+light*15;pixels[offset+2]=245+light*10;
    pixels[offset+3]=Math.round(255*alpha*(.91+light*.09));
    if(pixels[offset+3]>=128) covered++;
  }
  const texture=new THREE.DataTexture(pixels,textureSide,textureSide);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  texture.magFilter=THREE.NearestFilter;
  texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps=true;
  texture.userData.coverage=covered/field.length;
  texture.needsUpdate=true;
  return texture;
}

export class SnowAccumulation {
  constructor(scene,world,climate,{mobile=false,light=()=>0xffffff,chunkVisible=()=>true}={}) {
    this.world=world;
    this.climate=climate;
    this.light=light;
    this.chunkVisible=chunkVisible;
    this.coverage=snowCoverage(mobile);
    this.grainLimit=this.coverage.grainLimit;
    this.sideLimit=mobile?48:130;
    this.sideBudget=mobile?10:18;
    this.limit=this.coverage.bands.reduce((sum,band)=>sum+band.capacity,0)+this.grainLimit+this.sideLimit;
    this.cover=new RainCover(world);
    this.patches=new Map();
    this.masks=new Map();
    this.wallBoxes=new Map();
    this.cursors=[0,0,0];
    this.nextSurvey=0;
    this.clock={value:0};
    this.snowStarted={value:0};
    this.eye={value:new THREE.Vector3()};
    const glRange=([from,to])=>`vec2(${from.toFixed(1)},${to.toFixed(1)})`;
    const [near,middle,far]=this.coverage.bands.map(({range})=>glRange(range));
    const detail=glRange(this.coverage.detail),vertical=glRange(this.coverage.vertical);
    this.probe=new THREE.Object3D();
    this.probe.rotation.order='YXZ';
    this.tint=new THREE.Color();
    const geometry=new THREE.PlaneGeometry(1,1);
    geometry.rotateX(-Math.PI/2);
    this.fade=new THREE.InstancedBufferAttribute(new Float32Array(this.limit*4),4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('snowFade',this.fade);
    const material=new THREE.MeshBasicMaterial({transparent:true,alphaTest:.025,depthWrite:false,
      polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    material.onBeforeCompile=shader=>{
      shader.uniforms.snowNow=this.clock;
      shader.uniforms.snowStarted=this.snowStarted;
      shader.uniforms.snowEye=this.eye;
      shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
        uniform float snowNow;
        uniform float snowStarted;
        uniform vec3 snowEye;
        attribute vec4 snowFade;
        varying float snowOpacity;
        varying float snowLayer;
        varying vec2 snowWorld;
        varying vec2 snowLocal;`).replace('#include <begin_vertex>',`#include <begin_vertex>
        snowWorld=(modelMatrix*instanceMatrix*vec4(transformed,1.0)).xz;
        snowLocal=uv;
        snowLayer=snowFade.w;
        if (snowLayer==2.0) {
          vec3 outward=normalize(mat3(modelMatrix*instanceMatrix)*normal);
          snowWorld-=outward.xz*.010;
        }
        vec3 center=(modelMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
        vec3 distanceToEye=center-snowEye;
        vec2 limits=snowLayer==0.0 ? ${near} : snowLayer==3.0 ? ${middle} : snowLayer==4.0 ? ${far} : ${detail};
        vec2 down=${vertical};
        float distanceFade=1.0-smoothstep(limits.x,limits.y,length(distanceToEye.xz));
        float heightFade=(1.0-smoothstep(8.0,20.0,distanceToEye.y))*(1.0-smoothstep(down.x,down.y,-distanceToEye.y));
        float discovered=smoothstep(0.0,1.2,snowNow-snowFade.y);
        float settle=snowFade.y>=snowStarted ? smoothstep(0.0,5.0,snowNow-snowStarted) : 1.0;
        float melted=smoothstep(0.0,${duration.toFixed(1)},snowNow-snowFade.z);
        snowOpacity=snowFade.x*settle*discovered*(1.0-melted)*distanceFade*heightFade;`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying float snowOpacity;
        varying float snowLayer;
        varying vec2 snowWorld;
        varying vec2 snowLocal;`).replace('#include <map_fragment>',`
        diffuseColor *= texture2D(map,snowWorld/${textureBlocks.toFixed(1)});
        if (snowLayer == 2.0) {
          float broken=texture2D(map,(snowWorld+vec2(3.6,6.7))/${textureBlocks.toFixed(1)}).a;
          float roll=.32+.60*broken;
          diffuseColor.a *= smoothstep(1.0-roll,1.0,snowLocal.y);
          diffuseColor.rgb *= .93;
        } else if (snowLayer == 1.0) {
          vec4 grain=texture2D(map,(snowWorld+vec2(7.3,3.4))/${textureBlocks.toFixed(1)});
          float edge=1.0-smoothstep(.19,.49,length(snowLocal-vec2(.5)));
          diffuseColor.a = mix(.24,1.0,grain.a)*edge;
        }
        diffuseColor.a *= snowOpacity;`);
    };
    this.mesh=new THREE.InstancedMesh(geometry,material,this.limit);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled=false;
    this.mesh.count=0;
    this.mesh.renderOrder=2;
    scene.add(this.mesh);
    this.setStyle(0);
  }

  setStyle(style) {
    if(![0,1,2].includes(style)) return false;
    if(!this.masks.has(style)) this.masks.set(style,makeMask(style));
    this.mesh.material.map=this.masks.get(style);
    this.mesh.material.needsUpdate=true;
    return true;
  }

  invalidate(x,z) {
    this.cover.invalidate(x,z);
    this.patches.delete(x+','+z);
    for(let dz=-1;dz<=1;dz++) for(let dx=-1;dx<=1;dx++) {
      const neighbor=this.patches.get((x+dx)+','+(z+dz));
      if(neighbor) neighbor.sides=undefined;
    }
    this.nextSurvey=0;
  }

  exposed(x,z,eye,globalSnow=false) {
    if(!this.chunkVisible(x>>4,z>>4)) return null;
    const px=x+.5,pz=z+.5;
    const surface=this.cover.surfaceAt(px,pz);
    const y=surface.top;
    if(!Number.isFinite(y) || y>eye.y+24 || y<eye.y-this.coverage.vertical[1]-8 ||
        ['water','foliage','glass'].includes(surface.kind) ||
        (!globalSnow && !this.climate.snowAt(px,y+.035,pz))) return null;
    const footing=Math.floor(y-.0001);
    if(snowBlocks.has(blockState(this.world.cellAt(x,footing,z))[0]) ||
        snowBlocks.has(blockState(this.world.cellAt(x,Math.floor(y+.01),z))[0])) return null;
    const x0=surface.x0??0,x1=surface.x1??1,z0=surface.z0??0,z1=surface.z1??1;
    const width=x1-x0,depth=z1-z0;
    if(width<.15||depth<.15) return null;
    return {x:x+(x0+x1)*.5,y:y+.008,z:z+(z0+z1)*.5,width,depth,cellX:x,cellZ:z};
  }

  wallCell(x,y,z) {
    const key=x+','+y+','+z;
    if(this.wallBoxes.has(key)) return this.wallBoxes.get(key);
    const cell=this.world.cellAt(x,y,z);
    const neighbors=(dx,dy,dz)=>this.world.cellAt(x+dx,y+dy,z+dz);
    let solid=extractedModel(this.world.models,cell,neighbors)?.collision??collisionFor(cell,neighbors);
    if(cell?.voxels&&cell.parts) solid=[...solid,...coverBoxes(cell.parts)];
    const state=fluidState(cell);
    const fluid=state?fluidSurface(state,fluidState(neighbors(0,1,0))):0;
    const result={solid,fluid,snow:snowBlocks.has(blockState(cell)[0])};
    this.wallBoxes.set(key,result);
    return result;
  }

  fringeDepth(x,z,dx,dz,top,want) {
    const sx=x-dx*.008,sz=z-dz*.008,ax=x+dx*.008,az=z+dz*.008;
    const bx=Math.floor(sx),by=Math.floor(top-.0001),bz=Math.floor(sz);
    const nx=Math.floor(ax),nz=Math.floor(az),tip=top-by;
    if(!this.chunkVisible(nx>>4,nz>>4)) return 0;
    const contains=(box,lx,lz)=>lx>=box.x0 && lx<=box.x1 && lz>=box.z0 && lz<=box.z1;
    let thickness=0;
    for(const box of this.wallCell(bx,by,bz).solid) {
      if(Math.abs(box.y1-tip)<.007 && contains(box,sx-bx,sz-bz)) {
        thickness=Math.max(thickness,Math.min(want,tip-box.y0));
      }
    }
    if(thickness<.02) return 0;
    const other=this.wallCell(nx,by,nz);
    if(other.snow) return 0;
    if(other.fluid) thickness=Math.min(thickness,tip-other.fluid);
    for(const box of other.solid) {
      if(box.y0<tip-.002 && box.y1>tip-thickness && contains(box,ax-nx,az-nz)) {
        thickness=Math.min(thickness,tip-box.y1);
      }
    }
    return thickness>.02 ? Math.floor(thickness*256)/256 : 0;
  }

  fringes(patch) {
    const strips=[];
    const top=patch.y-.008;
    for(let side=0;side<faces.length;side++) {
      const [dx,dz,angle]=faces[side];
      const offset=(dx?patch.width:patch.depth)*.5;
      const span=dx?patch.depth:patch.width;
      const ex=patch.x+dx*offset,ez=patch.z+dz*offset;
      const count=Math.ceil(span*4),step=span/count;
      const want=.091+variation(patch.cellX,patch.cellZ,side+17)*.086;
      let run=0,previous=0;
      for(let i=0;i<=count;i++) {
        const shift=(i+.5)*step-span*.5;
        const depth=i===count?0:this.fringeDepth(ex+dz*shift,ez-dx*shift,dx,dz,top,want);
        if(depth===previous) continue;
        if(previous) {
          const middle=(run+i)*step*.5-span*.5;
          strips.push({x:ex+dz*middle+dx*wallOffset,y:patch.y-previous*.5,z:ez-dx*middle+dz*wallOffset,
            width:(i-run)*step,depth:previous,angle,side:true});
        }
        run=i;
        previous=depth;
      }
    }
    return strips;
  }

  grain(patch) {
    const {cellX,cellZ}=patch;
    if(variation(cellX,cellZ,5)>.29) return null;
    const ox=(variation(cellX,cellZ,1)-.5)*patch.width*.5;
    const oz=(variation(cellX,cellZ,2)-.5)*patch.depth*.5;
    const angle=(variation(cellX,cellZ,3)-.5)*Math.PI;
    let width=.3+.8*variation(cellX,cellZ,4),depth=.21+.63*variation(cellX,cellZ,7);
    const boundX=(Math.abs(Math.cos(angle))*width+Math.abs(Math.sin(angle))*depth)*.5;
    const boundZ=(Math.abs(Math.sin(angle))*width+Math.abs(Math.cos(angle))*depth)*.5;
    let overlaps=true;
    for(let x=Math.floor(patch.x+ox-boundX);x<=Math.floor(patch.x+ox+boundX);x++)
      for(let z=Math.floor(patch.z+oz-boundZ);z<=Math.floor(patch.z+oz+boundZ);z++) {
        const near=this.patches.get(x+','+z);
        if(!near || !this.chunkVisible(x>>4,z>>4) || near.y!==patch.y || near.width!==1 || near.depth!==1) overlaps=false;
      }
    if(!overlaps) {
      const shrink=Math.min(1,(patch.width*.5-Math.abs(ox))/boundX,(patch.depth*.5-Math.abs(oz))/boundZ);
      width*=shrink;
      depth*=shrink;
    }
    return {x:patch.x+ox,y:patch.y+.004,z:patch.z+oz,width,depth,angle};
  }

  writePatch(index,patch,weight,layer=0,plane=patch) {
    this.probe.position.set(plane.x,plane.y,plane.z);
    this.probe.scale.set(plane.width,1,plane.depth);
    this.probe.rotation.set(plane.side?Math.PI/2:0,plane.angle??0,0,'YXZ');
    this.probe.updateMatrix();
    this.mesh.setMatrixAt(index,this.probe.matrix);
    this.tint.setHex(patch.tint);
    this.mesh.setColorAt(index,this.tint);
    this.fade.setXYZW(index,weight,patch.created,patch.seen,layer);
  }

  survey(now,eye,snowing,globalSnow) {
    const time=now*.001;
    const {bands,vertical,detail}=this.coverage;
    const refresh=(x,z)=>{
      const key=x+','+z;
      const previous=this.patches.get(key);
      if(previous) return;
      const patch=this.exposed(x,z,eye,globalSnow);
      if(patch) this.patches.set(key,{...patch,band:snowColumnBand(x,z),created:time,seen:time});
    };
    if(snowing) {
      this.cover.beginFrame();
      refresh(Math.floor(eye.x),Math.floor(eye.z));
      for(let band=0;band<bands.length;band++) {
        const lane=bands[band];
        for(let i=0;i<lane.probes;i++) {
          const [x,z]=sampleSnowLane(lane,this.cursors[band]++,eye.x,eye.z);
          refresh(x,z);
        }
      }
    }
    const retention=bands.at(-1).radius+12;
    const details=[];
    const byBand=[0,0,0];
    let count=0;
    for(const [key,patch] of this.patches) {
      const distance=(patch.x-eye.x)**2+(patch.z-eye.z)**2;
      const height=patch.y-eye.y;
      if(time-patch.seen>=duration || distance>retention**2 ||
          !this.world.chunks.has((patch.cellX>>4)+','+(patch.cellZ>>4))) {
        this.patches.delete(key);
        continue;
      }
      if(distance>bands[patch.band].radius**2 || height>24 || height< -vertical[1]-8 ||
          !this.chunkVisible(patch.cellX>>4,patch.cellZ>>4)) continue;
      if(snowing && (globalSnow || this.climate.snowAt(patch.x,patch.y,patch.z))) patch.seen=time;
      patch.tint=this.light(patch.x,patch.y+.01,patch.z);
      this.writePatch(count++,patch,1,patch.band===0?0:patch.band+2);
      byBand[patch.band]++;
      if(distance<detail[1]**2 && Math.abs(height)<20) details.push({patch,distance});
    }
    this.topBands=byBand;
    details.sort((a,b)=>a.distance-b.distance);
    const bases=count;
    for(const {patch} of details) {
      if(count-bases>=this.grainLimit) break;
      const grain=this.grain(patch);
      if(grain) this.writePatch(count++,patch,.52,1,grain);
    }
    this.grains=count-bases;
    const fringeStart=count;
    let probes=this.sideBudget;
    this.wallBoxes.clear();
    for(const {patch} of details) {
      if(count>=fringeStart+this.sideLimit) break;
      if(!patch.sides && probes>0) {
        patch.sides=this.fringes(patch);
        probes--;
      }
      for(const strip of patch.sides??[]) {
        if(count>=fringeStart+this.sideLimit) break;
        this.writePatch(count++,patch,1,2,strip);
      }
    }
    this.fringeCount=count-fringeStart;
    this.mesh.count=count;
    this.mesh.instanceMatrix.needsUpdate=true;
    if(this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate=true;
    this.fade.needsUpdate=true;
  }

  update(now,eye,snowing,globalSnow=false) {
    this.clock.value=now*.001;
    if(snowing && !this.snowing) this.snowStarted.value=this.clock.value;
    this.snowing=snowing;
    const previous=this.eye.value;
    if(this.hasEye && ((previous.x-eye.x)**2+(previous.z-eye.z)**2>18**2 || Math.abs(previous.y-eye.y)>30)) {
      this.patches.clear();
      this.cover.columns.clear();
      this.cursors.fill(0);
      this.mesh.count=0;
      this.nextSurvey=0;
    }
    previous.set(eye.x,eye.y,eye.z);
    this.hasEye=true;
    if(now<this.nextSurvey) return;
    this.nextSurvey=now+(snowing?145:340);
    this.survey(now,eye,snowing,globalSnow);
  }

  inspect() {return {coating:this.mesh.count,retained:this.patches.size,grains:this.grains,fringes:this.fringeCount,
    topBands:this.topBands??[0,0,0],ranges:this.coverage.bands.map(band=>band.range),vertical:this.coverage.vertical,
    maskCoverage:this.mesh.material.map.userData.coverage};}
}
