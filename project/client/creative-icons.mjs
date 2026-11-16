import {TILE_SIZE} from '../world/geometry.mjs';
import {creativeMicroblock} from '../world/creative-items.mjs';
import {blockItemAppearance} from '../world/item-appearance.mjs';

const images=new Map();
const texturePath=family=>family==='terrain'?'/generated/textures/atlas.png':`/generated/models/${family}.png`;

function loadAtlas(family) {
  if (!images.has(family)) {
    images.set(family,(async()=>{
      const image=new Image();
      image.src=texturePath(family);
      await image.decode();
      const canvas=document.createElement('canvas');
      canvas.width=image.naturalWidth;
      canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(image,0,0);
      const {data}=context.getImageData(0,0,canvas.width,canvas.height);
      return {image,data,width:canvas.width,height:canvas.height};
    })().catch(error=>{images.delete(family);throw error;}));
  }
  return images.get(family);
}

const project=([x,y,z])=>[(x+z)*.88,(x-z)*.44-y*.9,x-z+y*.97];
const tintComponents=tint=>Number.isInteger(tint)?[tint>>16&255,tint>>8&255,tint&255]:[255,255,255];
const corners=[[0,1,2],[0,2,3]];
const edge=(ax,ay,bx,by,x,y)=>(bx-ax)*(y-ay)-(by-ay)*(x-ax);

function renderModel(output,model,atlas) {
  const {width,height,data}=output;
  const depth=new Float32Array(width*height).fill(-Infinity);
  const surfaces=model.quads.map(quad=>({...quad,projected:quad.points.map(project)}));
  const vertices=surfaces.flatMap(surface=>surface.projected);
  if (!vertices.length) return;
  const minX=Math.min(...vertices.map(point=>point[0])), maxX=Math.max(...vertices.map(point=>point[0]));
  const minY=Math.min(...vertices.map(point=>point[1])), maxY=Math.max(...vertices.map(point=>point[1]));
  const scale=Math.min((width-4)/Math.max(maxX-minX,.65),(height-4)/Math.max(maxY-minY,.75));
  function canvasPoint([x,y,z]) {
    return [(x-(minX+maxX)/2)*scale+width/2,(y-(minY+maxY)/2)*scale+height/2,z];
  }
  for (const {projected,uv,tint,shade,mode} of surfaces) {
    const points=projected.map(canvasPoint);
    const rgb=tintComponents(tint).map(value=>value*(shade??1)/255);
    for (const indices of corners) {
      const [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]=indices.map(index=>points[index]);
      const [[au,av],[bu,bv],[cu,cv]]=indices.map(index=>uv[index]);
      const face=edge(ax,ay,bx,by,cx,cy);
      if (Math.abs(face)<.0001) continue;
      const startX=Math.max(0,Math.floor(Math.min(ax,bx,cx))), endX=Math.min(width-1,Math.ceil(Math.max(ax,bx,cx)));
      const startY=Math.max(0,Math.floor(Math.min(ay,by,cy))), endY=Math.min(height-1,Math.ceil(Math.max(ay,by,cy)));
      for (let y=startY;y<=endY;y++) for (let x=startX;x<=endX;x++) {
        const a=edge(bx,by,cx,cy,x+.5,y+.5)/face, b=edge(cx,cy,ax,ay,x+.5,y+.5)/face, c=1-a-b;
        if (Math.min(a,b,c)<-.00001) continue;
        const position=x+y*width, nearer=az*a+bz*b+cz*c;
        if (nearer<=depth[position]+.00001) continue;
        const u=Math.max(0,Math.min(atlas.width-1,Math.floor((au*a+bu*b+cu*c)*atlas.width)));
        const v=Math.max(0,Math.min(atlas.height-1,Math.floor((av*a+bv*b+cv*c)*atlas.height)));
        const from=4*(u+v*atlas.width), into=position*4;
        const alpha=atlas.data[from+3];
        if (alpha<(mode==='blend'?12:64)) continue;
        depth[position]=nearer;
        for (let channel=0;channel<3;channel++) data[into+channel]=atlas.data[from+channel]*rgb[channel];
        data[into+3]=mode==='blend'?alpha:255;
      }
    }
  }
}

export async function renderCreativeIcon(entry,canvas,models) {
  const context=canvas.getContext('2d');
  if (!context) return false;
  context.imageSmoothingEnabled=false;
  context.clearRect(0,0,canvas.width,canvas.height);
  const sprite=models?.biblio?.items?.[entry.id+':'+(entry.invisible?0:entry.damage??entry.meta??0)];
  if (sprite?.uv&&!sprite.block) {
    const {image,width,height}=await loadAtlas('biblio');
    const [u0,v0,u1,v1]=sprite.uv;
    context.drawImage(image,u0*width,v0*height,(u1-u0)*width,(v1-v0)*height,0,0,canvas.width,canvas.height);
    return true;
  }
  const terrain=await loadAtlas('terrain');
  const part=entry.part??(entry.kind==='microblock'?creativeMicroblock(entry):undefined);
  const model=blockItemAppearance({key:entry.kind==='shaped-lamp'?entry.key:entry.blockKey??entry.key,
    ...(part&&{part}),...(entry.object&&{object:entry.object})},models,terrain.height/TILE_SIZE);
  const atlas=model.family==='terrain'?terrain:await loadAtlas(model.family);
  if (model.sprite && model.quads.length) {
    const {uv,tint}=model.quads[0];
    const u=Math.min(...uv.map(([x])=>x)), v=Math.min(...uv.map(([,y])=>y));
    const width=Math.max(...uv.map(([x])=>x))-u, height=Math.max(...uv.map(([,y])=>y))-v;
    context.drawImage(atlas.image,u*atlas.width,v*atlas.height,width*atlas.width,height*atlas.height,
      1,1,canvas.width-2,canvas.height-2);
    if (Number.isInteger(tint)) {
      const image=context.getImageData(0,0,canvas.width,canvas.height);
      const rgb=tintComponents(tint);
      for (let i=0;i<image.data.length;i+=4) for (let n=0;n<3;n++) image.data[i+n]*=rgb[n]/255;
      context.putImageData(image,0,0);
    }
  } else {
    const image=context.createImageData(canvas.width,canvas.height);
    renderModel(image,model,atlas);
    context.putImageData(image,0,0);
  }
  return true;
}
