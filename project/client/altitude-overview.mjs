import * as THREE from '/vendor/three/three.module.js';
import map from './altitude-map-data.mjs';
import {shapeFor} from '../world/geometry.mjs';

const highOverlayDistance=2304;
const detailFadeDistance=384;
const softenCanopyShadows=`
  // Lift baked forest shadows without changing the colors of lighter ground and roads.
  vec3 altitudeSurface=diffuseColor.rgb;
  float altitudeCanopy=smoothstep(0.0,0.007,altitudeSurface.g-max(altitudeSurface.r,altitudeSurface.b));
  float altitudeShadow=1.0-smoothstep(0.016,0.092,altitudeSurface.g);
  diffuseColor.rgb+=altitudeCanopy*altitudeShadow*vec3(0.016,0.025,0.013);
`;

export class AltitudeOverview {
  constructor(display) {
    this.display=display;
    this.supported=display.world.manifest.vista?.hash===map.vistaHash;
    this.scene=new THREE.Group();
    this.scene.visible=false;
    display.scene.add(this.scene);
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
      if (map.detail && !this.display.lowDevice) {
        colorLoader.loadAsync('/altitude-detail.webp').then(texture=>this.useDetailTexture(texture)).catch(error=>{
          console.warn('Nearby altitude map detail could not be loaded',error);
        });
      }
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
      const shade=new Float32Array(geometry.attributes.position.count*3);
      const normal=geometry.attributes.normal;
      for (let i=0;i<normal.count;i++) {
        const light=.83+.17*normal.getY(i)+.08*normal.getX(i)-.04*normal.getZ(i);
        shade.fill(light,i*3,i*3+3);
      }
      geometry.setAttribute('color',new THREE.BufferAttribute(shade,3));
      const material=new THREE.MeshBasicMaterial({vertexColors:true,polygonOffset:true,polygonOffsetFactor:-1,
        polygonOffsetUnits:-1});
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
    const {west,north,step,columns,rows,heightScale}=map;
    const canvas=document.createElement('canvas');
    canvas.width=columns; canvas.height=rows;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if (heightImage.width!==columns || heightImage.height!==rows) throw new Error('Invalid altitude height map dimensions');
    ctx.drawImage(heightImage,0,0);
    const pixels=ctx.getImageData(0,0,columns,rows).data;
    const vertices=new Float32Array(columns*rows*3), uv=new Float32Array(columns*rows*2);
    const indices=[];
    for (let z=0;z<rows;z++) for (let x=0;x<columns;x++) {
      const at=x+z*columns;
      const y=(pixels[at*4]*256+pixels[at*4+1])/heightScale;
      // Display disables automatic world matrices. Keep the immutable relief in world coordinates.
      vertices.set([west+x*step,y,north+z*step],at*3);
      uv.set([x/(columns-1),1-z/(rows-1)],at*2);
      if (x>=columns-1 || z>=rows-1) continue;
      const a=at,b=a+1,c=a+columns,d=c+1;
      if (pixels[a*4+3]&&pixels[b*4+3]&&pixels[c*4+3]) indices.push(a,c,b);
      if (pixels[d*4+3]&&pixels[b*4+3]&&pixels[c*4+3]) indices.push(b,c,d);
    }
    this.configureTexture(colors);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(vertices,3));
    geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const material=new THREE.MeshBasicMaterial({map:colors});
    material.onBeforeCompile=shader=>{
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
        #include <map_fragment>
        ${softenCanopyShadows}
      `);
    };
    this.mesh=new THREE.Mesh(geometry,material);
    this.scene.add(this.mesh);
  }

  configureTexture(texture) {
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.magFilter=THREE.NearestFilter;
    texture.anisotropy=Math.min(8,this.display.renderer.capabilities.getMaxAnisotropy());
  }

  useDetailTexture(texture) {
    const {west,north,east,south,detail}=map;
    const width=east-west, length=south-north;
    this.configureTexture(texture);
    const origin=new THREE.Vector2((detail.west-west)/width,(south-detail.south)/length);
    const span=new THREE.Vector2((detail.east-detail.west)/width,(detail.south-detail.north)/length);
    const feather=new THREE.Vector2(detailFadeDistance/(detail.east-detail.west),detailFadeDistance/(detail.south-detail.north));
    const material=this.mesh.material;
    material.onBeforeCompile=shader=>{
      shader.uniforms.altitudeDetail={value:texture};
      shader.uniforms.altitudeOrigin={value:origin};
      shader.uniforms.altitudeSpan={value:span};
      shader.uniforms.altitudeFeather={value:feather};
      shader.fragmentShader=`
        uniform sampler2D altitudeDetail;
        uniform vec2 altitudeOrigin;
        uniform vec2 altitudeSpan;
        uniform vec2 altitudeFeather;
      `+shader.fragmentShader.replace('#include <map_fragment>',`
        #include <map_fragment>
        vec2 detailUv=(vMapUv-altitudeOrigin)/altitudeSpan;
        // Derivatives must be evaluated before fragments diverge at the detail boundary.
        vec2 detailDx=dFdx(detailUv),detailDy=dFdy(detailUv);
        vec2 weight=smoothstep(vec2(0.0),altitudeFeather,min(detailUv,1.0-detailUv));
        if (weight.x*weight.y>0.0) {
          diffuseColor.rgb=mix(diffuseColor.rgb,textureGrad(altitudeDetail,detailUv,detailDx,detailDy).rgb,weight.x*weight.y);
        }
        ${softenCanopyShadows}
      `);
    };
    material.needsUpdate=true;
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
}
