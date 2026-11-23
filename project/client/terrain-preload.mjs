export function createTerrainPreload({manifest,build,mobile,backgroundBusy}) {
  let worker,timer,sampler;
  let lowDevice, configuration, status={phase:mobile?'idle':'starting'};
  let mobileConsent;
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
    const current=new Worker(new URL('./terrain-preload-worker.mjs',import.meta.url),{type:'module'});
    worker=current;
    function defer() {current.postMessage({type:'defer',enabled:backgroundBusy()});}
    function accept(next) {
      if (worker!==current) return;
      status=next;
      lastProgress=performance.now();
      if (next.phase==='loading') return;
      stop();
      if (next.phase==='retry') timer=setTimeout(start,45_000);
    }
    current.onmessage=({data})=>accept(data);
    current.onerror=()=>accept({phase:'retry'});
    defer();
    current.postMessage({type:'start',manifest:{lod:manifest.lod,vista:manifest.vista},build,mobile,lowDevice});
    sampler=setInterval(defer,1000);
  }

  return {
    setMode(enabled,cacheConfiguration) {
      if (lowDevice===enabled && configuration===cacheConfiguration) return;
      lowDevice=enabled;
      configuration=cacheConfiguration;
      if (configuration!=='configured') {
        stop();
        status={phase:configuration,blocked:true};
      } else if (enabled && !manifest.vista) {
        stop();
        status={phase:'unavailable',blocked:true};
      } else if (!mobile || mobileConsent==='normal' || enabled && mobileConsent==='low') {
        start();
      } else {
        stop();
        status={phase:'idle'};
      }
    },
    request() {
      if (configuration!=='configured' || status.blocked || ['starting','loading','ready'].includes(status.phase)) return;
      if (!lowDevice) mobileConsent='normal';
      else if (!mobileConsent) mobileConsent='low';
      start();
    },
    status:()=>status,
    prioritizing:()=>(status.phase==='starting' || status.phase==='loading') && performance.now()-lastProgress<8000,
  };
}
