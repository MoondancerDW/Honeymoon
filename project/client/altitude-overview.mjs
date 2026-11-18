import * as THREE from '/vendor/three/three.module.js';
import map from './altitude-map-data.mjs';
import {shapeFor} from '../world/geometry.mjs';

const regionSize=512;
const highOverlayDistance=2304;
const bakedWest=Math.floor(map.west/regionSize), bakedNorth=Math.floor(map.north/regionSize);
const bakedWidth=Math.ceil(map.east/regionSize)-bakedWest, bakedHeight=Math.ceil(map.south/regionSize)-bakedNorth;

export class AltitudeOverview {
  constructor(display) {
    this.display=display;
    this.supported=display.world.manifest.vista?.hash===map.vistaHash;
    this.scene=new THREE.Group();
    this.scene.visible=false;
    display.scene.add(this.scene);
    this.refinements=new Uint8Array(bakedWidth*bakedHeight);
    this.mask=new THREE.DataTexture(this.refinements,bakedWidth,bakedHeight,THREE.RedFormat);
    this.mask.minFilter=this.mask.magFilter=THREE.NearestFilter;
    this.mask.needsUpdate=true;
    this.highBlocks=new THREE.Group();
    display.scene.add(this.highBlocks);
    this.upperRevision=-1;
  }

  prepare(now) {
    if (this.loading) return this.loading;
    if (!this.supported || this.mesh || now<(this.retryAt ?? 0)) return;
    const images=new THREE.ImageLoader();
    const colorLoader=new THREE.TextureLoader();
    void this.loadLandmarks();
    // Keep the assets independent of the active chunk and scenery downloads.
    this.loading=Promise.allSettled([images.loadAsync('/altitude-heights.png'),colorLoader.loadAsync('/altitude-colors.webp')]).then(results=>{
      const [height,color]=results;
      if (height.status!=='fulfilled' || color.status!=='fulfilled') {
        if (color.status==='fulfilled') color.value.dispose();
        throw new Error('Missing altitude map');
      }
      this.build(height.value,color.value);
    }).catch(error=>{
      this.retryAt=performance.now()+5000;
      console.warn('Altitude map could not be loaded',error);
    }).finally(()=>{this.loading=null;});
    return this.loading;
  }

  async loadLandmarks() {
    if (this.landmarkLoading || this.landmarks) return;
    this.landmarkLoading=true;
    try {
      const {default:packed}=await import('./altitude-landmark-data.mjs');
      const compressed=Uint8Array.from(atob(packed),value=>value.charCodeAt(0));
      const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
      const groups=await new Response(stream).json();
      const geometry=new THREE.BoxGeometry(1,1,1);
      const material=new THREE.MeshBasicMaterial({polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
      const markers=new THREE.Group();
      const dummy=new THREE.Object3D(), color=new THREE.Color();
      for (const {key,boxes} of groups) {
        if (!boxes.length) continue;
        const mesh=new THREE.InstancedMesh(geometry,material,boxes.length);
        mesh.name=key;
        for (const [i,[x,y,z,dx,dy,dz,tile,tint]] of boxes.entries()) {
          dummy.position.set(x+dx/2,y+dy/2,z+dz/2);
          dummy.scale.set(dx,dy,dz);
          dummy.updateMatrix();
          mesh.setMatrixAt(i,dummy.matrix);
          mesh.setColorAt(i,this.landmarkColor(color,tile,tint));
        }
        mesh.computeBoundingSphere();
        markers.add(mesh);
      }
      this.landmarks=markers;
      this.scene.add(markers);
    } catch (error) {
      console.warn('Altitude landmark detail could not be loaded',error);
    } finally {
      this.landmarkLoading=false;
    }
  }

  landmarkColor(color,tile,tint) {
    const average=this.display.terrainTextures?.average?.image;
    const row=average?.height-1-Math.floor(tile/64);
    const at=4*(row*64+(tile%64));
    if (average?.data && at>=0 && at+2<average.data.length) {
      const data=average.data;
      color.setRGB(data[at]/255,data[at+1]/255,data[at+2]/255,THREE.SRGBColorSpace);
      if (tint!==undefined) color.multiply(new THREE.Color(tint));
    } else color.set(tint ?? 0xa7a5a2);
    return color;
  }

  build(heightImage, colors) {
    const {west,north,east,south,step,columns,rows}=map;
    const canvas=document.createElement('canvas');
    canvas.width=columns; canvas.height=rows;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(heightImage,0,0);
    const pixels=ctx.getImageData(0,0,columns,rows).data;
    const vertices=new Float32Array(columns*rows*3), uv=new Float32Array(columns*rows*2);
    const indices=[];
    for (let z=0;z<rows;z++) for (let x=0;x<columns;x++) {
      const at=x+z*columns, y=pixels[at*4];
      vertices.set([west+x*step-(west+east)/2,y-1,north+z*step-(north+south)/2],at*3);
      uv.set([x/(columns-1),1-z/(rows-1)],at*2);
      if (x>=columns-1 || z>=rows-1) continue;
      const a=at,b=a+1,c=a+columns,d=c+1;
      if (pixels[a*4+3]&&pixels[b*4+3]&&pixels[c*4+3]) indices.push(a,c,b);
      if (pixels[d*4+3]&&pixels[b*4+3]&&pixels[c*4+3]) indices.push(b,c,d);
    }
    colors.colorSpace=THREE.SRGBColorSpace;
    colors.anisotropy=Math.min(4,this.display.renderer.capabilities.getMaxAnisotropy());
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(vertices,3));
    geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const material=new THREE.MeshBasicMaterial({map:colors});
    material.onBeforeCompile=shader=>{
      shader.uniforms.altitudeMask={value:this.mask};
      shader.uniforms.altitudeMaskOrigin={value:new THREE.Vector2(bakedWest,bakedNorth)};
      shader.uniforms.altitudeMaskSize={value:new THREE.Vector2(bakedWidth,bakedHeight)};
      shader.vertexShader='varying vec2 altitudeXZ;\n'+shader.vertexShader
        .replace('#include <begin_vertex>','#include <begin_vertex>\n altitudeXZ=(modelMatrix*vec4(position,1.)).xz;');
      shader.fragmentShader='uniform sampler2D altitudeMask;\nuniform vec2 altitudeMaskOrigin, altitudeMaskSize;\nvarying vec2 altitudeXZ;\n'+
        shader.fragmentShader.replace('#include <alphatest_fragment>',`#include <alphatest_fragment>
          vec2 tile=floor(altitudeXZ/512.)-altitudeMaskOrigin;
          float ready=texture2D(altitudeMask,(tile+.5)/altitudeMaskSize).r;
          float dither=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))));
          if (dither<ready) discard;`);
    };
    this.mesh=new THREE.Mesh(geometry,material);
    this.mesh.position.set((west+east)/2,0,(north+south)/2);
    this.scene.add(this.mesh);
  }

  setRefinement(rx,rz,coverage) {
    const x=rx-bakedWest,z=rz-bakedNorth;
    if (x<0 || z<0 || x>=bakedWidth || z>=bakedHeight) return;
    const index=x+z*bakedWidth,value=Math.round(255*coverage);
    if (value===this.refinements[index]) return;
    this.refinements[index]=value;
    this.mask.needsUpdate=true;
  }

  updateHighBlocks(position, now) {
    const {world}=this.display;
    const x=Math.floor(position.x/16), z=Math.floor(position.z/16);
    if (now<(this.nextHighCheck ?? 0) || this.upperRevision===world.upperRevision && this.upperX===x && this.upperZ===z) return;
    this.nextHighCheck=now+180;
    this.upperRevision=world.upperRevision;
    this.upperX=x; this.upperZ=z;
    const color=new THREE.Color();
    const above=world.upperOverrides;
    const visible=[];
    const exactRadius=this.display.detailedDistance;
    for (const change of above.values()) {
      const {x:bx,y,z:bz}=change;
      const dx=bx-position.x,dz=bz-position.z;
      if (dx*dx+dz*dz>highOverlayDistance**2) continue;
      const cx=bx>>4, cz=bz>>4;
      const exact=Math.max(Math.abs(cx-x),Math.abs(cz-z))<=exactRadius;
      if (exact && this.display.groups.get(`${cx},${y>>4},${cz}`)?.visible) continue;
      const shape=shapeFor({key:world.palette[change.index],object:change.object,
        parts:change.parts,voxels:change.voxels})[0];
      if (!shape) continue;
      visible.push({x:bx,y,z:bz,shape});
    }
    const previous=this.highBlocks.children[0];
    if (previous) {
      previous.removeFromParent();
      previous.geometry.dispose();
      previous.material.dispose();
      previous.dispose();
    }
    if (!visible.length) return;
    const geometry=new THREE.BoxGeometry(1,1,1);
    const material=new THREE.MeshBasicMaterial();
    const blocks=new THREE.InstancedMesh(geometry,material,visible.length);
    const temp=new THREE.Object3D();
    for (const [i,block] of visible.entries()) {
      const {x,y,z,shape}=block;
      const low=shape.y0 ?? 0, high=shape.y1 ?? 1;
      temp.position.set(x+.5,y+(low+high)/2,z+.5);
      temp.scale.set(1,Math.max(.06,high-low),1);
      temp.updateMatrix();
      blocks.setMatrixAt(i,temp.matrix);
      blocks.setColorAt(i,this.landmarkColor(color,shape.faces[3],shape.tint));
    }
    blocks.computeBoundingSphere();
    this.highBlocks.add(blocks);
  }

  invalidateHighBlocks() {
    this.upperRevision=-1;
  }

  renderMap({x,z,yaw}) {
    if (!this.mapScene) {
      this.mapScene=new THREE.Scene();
      this.mapScene.background=new THREE.Color(0x182b32);
      const terrain=new THREE.Mesh(this.mesh.geometry,new THREE.MeshBasicMaterial({map:this.mesh.material.map}));
      terrain.position.copy(this.mesh.position);
      this.mapScene.add(terrain);
      const marker=new THREE.BufferGeometry();
      marker.setAttribute('position',new THREE.Float32BufferAttribute([0,0,-1,.55,0,.6,-.55,0,.6],3));
      this.mapMarker=new THREE.Mesh(marker,new THREE.MeshBasicMaterial({color:0xf8d078,side:THREE.DoubleSide}));
      this.mapScene.add(this.mapMarker);
      this.mapCamera=new THREE.OrthographicCamera(-1,1,1,-1,.1,2200);
      this.mapCamera.up.set(0,0,-1);
      this.mapCamera.position.set((map.west+map.east)/2,1400,(map.north+map.south)/2);
      this.mapCamera.lookAt(this.mapCamera.position.x,0,this.mapCamera.position.z);
    }
    const {renderer,camera:{aspect}}=this.display;
    const halfHeight=Math.max(map.south-map.north,(map.east-map.west)/aspect)*.54;
    const camera=this.mapCamera;
    camera.left=-halfHeight*aspect; camera.right=halfHeight*aspect;
    camera.top=halfHeight; camera.bottom=-halfHeight;
    camera.updateProjectionMatrix();
    this.mapMarker.position.set(x,260,z);
    this.mapMarker.rotation.y=yaw;
    this.mapMarker.scale.setScalar(halfHeight*.032);
    renderer.render(this.mapScene,camera);
  }
}
