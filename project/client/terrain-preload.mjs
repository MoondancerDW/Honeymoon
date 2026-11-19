export function createTerrainPreload({manifest,build,mobile,backgroundBusy}) {
  let worker,timer,sampler;
  let lowDevice, status={phase:'starting'};
  let lastProgress=0;

  function stop() {
    worker?.terminate();
    worker=undefined;
    clearInterval(sampler);
    clearTimeout(timer);
  }

  function start() {
    stop();
    status={phase:'starting'};
    lastProgress=performance.now();
    worker=new Worker(new URL('./terrain-preload-worker.mjs',import.meta.url),{type:'module'});
    function defer() {worker?.postMessage({type:'defer',enabled:backgroundBusy()});}
    function accept(next) {
      status=next;
      lastProgress=performance.now();
      if (next.phase==='loading') return;
      stop();
      if (next.phase==='retry') timer=setTimeout(start,45_000);
    }
    worker.onmessage=({data})=>accept(data);
    worker.onerror=()=>accept({phase:'retry'});
    defer();
    worker.postMessage({type:'start',manifest:{lod:manifest.lod,vista:manifest.vista},build,simplified:!mobile&&!lowDevice});
    sampler=setInterval(defer,1000);
  }

  return {
    setMode(enabled) {
      if (lowDevice===enabled) return;
      lowDevice=enabled;
      start();
    },
    status:()=>status,
    prioritizing:()=>(status.phase==='starting' || status.phase==='loading') && performance.now()-lastProgress<8000,
  };
}
