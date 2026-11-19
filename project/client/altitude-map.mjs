import overview from './altitude-map-data.mjs';
import {VISTA_BLOCKS} from './vista-format.mjs';

const packBlocks=64;
const maxScale=8;
const maxFetch=2;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const regionKey=(x,z)=>`${x}.${z}`;
const trackPoint=(x,y)=>({x,y});
const midpoint=([a,b])=>trackPoint((a.x+b.x)/2,(a.y+b.y)/2);
const distance=([a,b])=>Math.hypot(a.x-b.x,a.y-b.y);

function layersFor({vista,lod}) {
  const descriptor=(name,size,hash,regions,limit)=>({
    name,size,hash,limit,regions:new Set(regions.map(([x,z])=>regionKey(x,z))),cache:new Map(),
  });
  return [
    vista?.hash && descriptor('vista',VISTA_BLOCKS,vista.hash,vista.regions,32),
    lod?.tileChunks===4 && descriptor('lod',packBlocks,lod.contentHash,lod.regions,128),
  ].filter(Boolean);
}

function visibleTiles(layer,{west,north,east,south,x,z}) {
  const tiles=[];
  const {size}=layer;
  for (let rz=Math.floor(north/size); rz<=Math.floor(south/size); rz++) {
    for (let rx=Math.floor(west/size); rx<=Math.floor(east/size); rx++) {
      const key=regionKey(rx,rz);
      if (!layer.regions.has(key)) continue;
      tiles.push({layer,key,id:`${layer.name}/${key}`,x:rx*size,z:rz*size,
        distance:((rx+.5)*size-x)**2+((rz+.5)*size-z)**2});
    }
  }
  return tiles;
}

function control(parent,label,text,action) {
  const button=document.createElement('button');
  button.type='button';
  button.textContent=text;
  button.setAttribute('aria-label',label);
  button.title=label;
  button.addEventListener('click',action);
  parent.append(button);
  return button;
}

export function createAltitudeMap({game,openButton,backButton,manifest,palette,localMarker,remoteMarkers,pause,persistentTerrain}) {
  const hasOverview=manifest.vista?.hash===overview.vistaHash;
  const layers=layersFor(manifest);
  if (!hasOverview && !layers.length) return;
  const {minX,minZ,maxX,maxZ}=manifest.bounds;
  const bounds=hasOverview?overview:{west:minX,north:minZ,east:maxX+1,south:maxZ+1};
  const spanX=bounds.east-bounds.west, spanZ=bounds.south-bounds.north;
  const centerX=(bounds.west+bounds.east)/2, centerZ=(bounds.north+bounds.south)/2;
  const pointers=new Map();
  const inflight=new Set();
  const failures=new Map();
  let active=false, width=0, height=0, dpr=1, minScale=0, scale=1, x=centerX, z=centerZ;
  let frame=0, timer, retryTimer, image, worker, workerFailed=false, markers=[], lastMarkers='';

  const dialog=document.createElement('section');
  dialog.id='altitude-map-panel';
  dialog.setAttribute('role','dialog');
  dialog.setAttribute('aria-label','Карта мира');
  dialog.setAttribute('aria-modal','true');
  dialog.hidden=true;
  const canvas=document.createElement('canvas');
  canvas.tabIndex=0;
  canvas.setAttribute('aria-label','Карта мира. Стрелки перемещают карту, плюс и минус меняют масштаб.');
  const context=canvas.getContext('2d',{alpha:false});
  if (!context) return;
  const toolbar=document.createElement('div');
  toolbar.className='altitude-map-controls';
  backButton.hidden=false;
  backButton.addEventListener('click',close);
  toolbar.append(backButton);
  const controls=document.createElement('div');
  toolbar.append(controls);
  control(controls,'Весь мир','⛶',fit);
  control(controls,'Моя позиция','⌖',locate);
  const minus=control(controls,'Отдалить','−',()=>zoom(1/1.6));
  const plus=control(controls,'Приблизить','+',()=>zoom(1.6));
  dialog.append(canvas,toolbar);
  game.append(dialog);
  openButton.hidden=false;
  openButton.addEventListener('click',open);
  window.addEventListener('resize',schedule);

  function startWorker() {
    if (worker || workerFailed) return;
    try {
      worker=new Worker(new URL('./altitude-map-worker.mjs',import.meta.url),{type:'module'});
      if (palette) worker.postMessage({colors:palette});
      worker.onmessage=({data:{id,pixels,size,retry}})=>{
        inflight.delete(id);
        const [name,key]=id.split('/');
        if (pixels) {
          const layer=layers.find(item=>item.name===name);
          const tile=document.createElement('canvas');
          tile.width=tile.height=size;
          tile.getContext('2d').putImageData(new ImageData(pixels,size,size),0,0);
          layer.cache.set(key,tile);
          while (layer.cache.size>layer.limit) layer.cache.delete(layer.cache.keys().next().value);
        } else if (retry) {
          failures.set(id,performance.now()+10_000);
          if (failures.size>128) failures.delete(failures.keys().next().value);
        }
        schedule();
      };
      worker.onerror=()=>{
        worker.terminate();
        worker=null;
        workerFailed=true;
        inflight.clear();
      };
    } catch {
      workerFailed=true;
    }
  }

  function synchronizeSize() {
    const w=canvas.clientWidth, h=canvas.clientHeight;
    const ratio=Math.min(2,window.devicePixelRatio||1);
    if (!w || !h || w===width && h===height && dpr===ratio) return;
    const fitted=scale<=minScale*1.001;
    width=w;
    height=h;
    dpr=ratio;
    canvas.width=Math.round(w*dpr);
    canvas.height=Math.round(h*dpr);
    minScale=Math.min(width/spanX,height/spanZ);
    scale=fitted?minScale:clamp(scale,minScale,maxScale);
  }

  function constrain() {
    const hw=width/(2*scale), hh=height/(2*scale);
    x=2*hw>=spanX?centerX:clamp(x,bounds.west+hw,bounds.east-hw);
    z=2*hh>=spanZ?centerZ:clamp(z,bounds.north+hh,bounds.south-hh);
  }

  function fit() {
    scale=minScale;
    x=centerX;
    z=centerZ;
    schedule();
  }

  function locate() {
    const marker=localMarker();
    if (!marker) return;
    x=marker.x;
    z=marker.z;
    scale=Math.max(scale,1);
    schedule();
  }

  function zoom(factor,at=trackPoint(width/2,height/2),from=at) {
    const next=clamp(scale*factor,minScale,maxScale);
    x+=(from.x-width/2)/scale-(at.x-width/2)/next;
    z+=(from.y-height/2)/scale-(at.y-height/2)/next;
    scale=next;
    schedule();
  }

  function updateMarkers() {
    const local=localMarker();
    const next=[...remoteMarkers(),...(local?[{...local,local:true}]:[])];
    const signature=JSON.stringify(next);
    if (signature===lastMarkers) return;
    lastMarkers=signature;
    markers=next;
    schedule();
  }

  function open() {
    if (active) return;
    pause();
    active=true;
    dialog.hidden=false;
    game.classList.add('altitude-map-open');
    synchronizeSize();
    fit();
    backButton.focus({preventScroll:true});
    updateMarkers();
    timer=setInterval(updateMarkers,250);
    if (hasOverview && !image) {
      image=new Image();
      image.addEventListener('load',schedule,{once:true});
      image.addEventListener('error',()=>{image=null; schedule();},{once:true});
      image.src=new URL('./altitude-colors.webp',import.meta.url);
    }
  }

  function close() {
    if (!active) return;
    active=false;
    cancelAnimationFrame(frame);
    frame=0;
    clearInterval(timer);
    clearTimeout(retryTimer);
    retryTimer=null;
    pointers.clear();
    for (const id of inflight) worker?.postMessage({id,cancel:true});
    dialog.hidden=true;
    game.classList.remove('altitude-map-open');
    openButton.focus({preventScroll:true});
  }

  function schedule() {
    if (active && !frame) frame=requestAnimationFrame(draw);
  }

  function queueTiles(visible) {
    const needed=new Set(visible.filter(tile=>!tile.layer.cache.has(tile.key)).map(tile=>tile.id));
    for (const id of inflight) if (!needed.has(id)) worker?.postMessage({id,cancel:true});
    if (!needed.size || inflight.size>=maxFetch) return;
    startWorker();
    if (!worker) return;
    const now=performance.now();
    let nextRetry=Infinity;
    visible.sort((a,b)=>b.layer.size-a.layer.size||a.distance-b.distance);
    for (const {layer,id,key} of visible) {
      if (!needed.has(id) || inflight.has(id)) continue;
      const retry=failures.get(id);
      if (retry>now) {
        nextRetry=Math.min(nextRetry,retry);
        continue;
      }
      failures.delete(id);
      inflight.add(id);
      worker.postMessage({id,url:`/generated/${layer.name}/${layer.hash}/${key}.bin`,vista:layer.name==='vista',persistentTerrain});
      if (inflight.size>=maxFetch) break;
    }
    clearTimeout(retryTimer);
    if (Number.isFinite(nextRetry)) retryTimer=setTimeout(schedule,nextRetry-now+25);
  }

  function drawMarkers(screenX,screenY) {
    const placed=[];
    context.font='600 13px "Segoe UI", system-ui, sans-serif';
    context.textAlign='center';
    context.textBaseline='middle';
    context.lineJoin='round';
    for (const {x,z,name,local} of markers) {
      const px=screenX(x),py=screenY(z);
      if (!Number.isFinite(px) || !Number.isFinite(py) || px<0 || py<0 || px>width || py>height) continue;
      context.beginPath();
      context.arc(px,py,local?6:5,0,2*Math.PI);
      context.fillStyle=local?'#f0d297':'#def7fc';
      context.strokeStyle='#142027';
      context.lineWidth=2;
      context.fill();
      context.stroke();
      const label=name || (local?'Вы':'');
      if (!label) continue;
      const tw=Math.min(width-8,Math.ceil(context.measureText(label).width)+12);
      const left=clamp(px-tw/2,4,width-tw-4);
      const overlaps=top=>placed.some(other=>other.left<left+tw && other.right>left && Math.abs(other.top-top)<22);
      const preferred=clamp(py<84?py+10:py-28,48,height-24);
      let top=preferred;
      for (let offset=22; overlaps(top) && offset<height; offset+=22) {
        if (preferred+offset<=height-24 && !overlaps(preferred+offset)) top=preferred+offset;
        else if (preferred-offset>=48 && !overlaps(preferred-offset)) top=preferred-offset;
      }
      placed.push({left,right:left+tw,top});
      if (Math.abs(top+10-py)>20) {
        context.beginPath();
        context.moveTo(px,py);
        context.lineTo(left+tw/2,top+10);
        context.strokeStyle='#101e25aa';
        context.lineWidth=1;
        context.stroke();
      }
      context.fillStyle='#112129ed';
      context.fillRect(left,top,tw,20);
      context.fillStyle=local?'#f0d297':'#f0f7f5';
      context.fillText(label,left+tw/2,top+10,tw-8);
    }
  }

  function draw() {
    frame=0;
    if (!active) return;
    synchronizeSize();
    constrain();
    minus.disabled=scale<=minScale*1.001;
    plus.disabled=scale>=maxScale;
    context.setTransform(dpr,0,0,dpr,0,0);
    context.fillStyle='#172928';
    context.fillRect(0,0,width,height);
    const screenX=worldX=>(worldX-x)*scale+width/2;
    const screenY=worldZ=>(worldZ-z)*scale+height/2;
    if (image?.naturalWidth) {
      context.imageSmoothingEnabled=scale<.125;
      context.drawImage(image,screenX(bounds.west),screenY(bounds.north),spanX*scale,spanZ*scale);
    }
    const extent={x,z,west:x-width/(2*scale),east:x+width/(2*scale),north:z-height/(2*scale),south:z+height/(2*scale)};
    const nearScale=Math.max(.9,Math.sqrt(width*height/64)/packBlocks);
    const visible=[];
    context.imageSmoothingEnabled=false;
    for (const layer of layers) {
      const threshold=layer.name==='vista' ? (image?.naturalWidth ? .08 : .035) : nearScale;
      if (scale<threshold) continue;
      for (const tile of visibleTiles(layer,extent)) {
        const cached=layer.cache.get(tile.key);
        if (cached) {
          layer.cache.delete(tile.key);
          layer.cache.set(tile.key,cached);
          const left=Math.round(screenX(tile.x)), top=Math.round(screenY(tile.z));
          context.drawImage(cached,left,top,Math.round(screenX(tile.x+layer.size))-left,
            Math.round(screenY(tile.z+layer.size))-top);
        }
        visible.push(tile);
      }
    }
    queueTiles(visible);
    drawMarkers(screenX,screenY);
  }

  function point(event) {
    const {left,top}=canvas.getBoundingClientRect();
    return trackPoint(event.clientX-left,event.clientY-top);
  }

  canvas.addEventListener('pointerdown',event=>{
    if (event.button!==0 || pointers.size>=2) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,point(event));
  });
  canvas.addEventListener('pointermove',event=>{
    const previous=pointers.get(event.pointerId);
    if (!previous) return;
    const before=[...pointers.values()], current=point(event);
    pointers.set(event.pointerId,current);
    if (before.length===1) {
      x+=(previous.x-current.x)/scale;
      z+=(previous.y-current.y)/scale;
      schedule();
      return;
    }
    const after=[...pointers.values()];
    zoom(distance(after)/Math.max(1,distance(before)),midpoint(after),midpoint(before));
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    canvas.addEventListener(type,event=>pointers.delete(event.pointerId));
  }
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?height:1);
    zoom(Math.exp(clamp(-delta*.0018,-.55,.55)),point(event));
  },{passive:false});
  canvas.addEventListener('dblclick',event=>zoom(1.8,point(event)));
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  document.addEventListener('keydown',event=>{
    if (!active) return;
    event.stopImmediatePropagation();
    switch (event.key) {
      case 'Escape': close(); break;
      case '+': case '=': zoom(1.6); break;
      case '-': zoom(1/1.6); break;
      case '0': fit(); break;
      case 'ArrowUp': z-=72/scale; schedule(); break;
      case 'ArrowDown': z+=72/scale; schedule(); break;
      case 'ArrowLeft': x-=72/scale; schedule(); break;
      case 'ArrowRight': x+=72/scale; schedule(); break;
      default: return;
    }
    event.preventDefault();
  },true);
}
