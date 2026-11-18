import {connectionFailure} from './connection-report.mjs';

const pingInterval=5000;
const recoveryInterval=2000;

export function createConnectionStatus({element,onRecover,onLatency,active,report,diagnostics}) {
  const fps=element('connection-fps'),ping=element('connection-ping');
  const alert=element('connection-alert'),message=element('connection-message'),retry=element('connection-retry');
  let reachable,live,wasLive=false,predictionPaused=false,terrainWaiting=false,startupStopped=false,autoReload=false,request,timer,warmed=false;
  let lastFrameCount,lastFrameSample,local=false;

  function paint() {
    const text=startupStopped && !autoReload ? 'Сервер недоступен. Повторите подключение.' :
      startupStopped || (!wasLive && (reachable===false || live===false)) ? 'Сервер недоступен. Подключаемся повторно…' :
      predictionPaused ? 'Восстанавливаем связь…' :
      terrainWaiting==='solo-unavailable' ? 'Район ещё не скачан. Подключите интернет для загрузки.' :
      terrainWaiting ? 'Загружаем ближайший участок…' :
      (live===false || reachable===false ? 'Нестабильная связь. Восстанавливаем соединение…' : '');
    if (message.textContent!==text) message.textContent=text;
    alert.hidden=!text;
    retry.hidden=!startupStopped;
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer=setTimeout(()=>void check(),delay);
  }

  function check() {
    if (request) return request;
    clearTimeout(timer);
    request=(async()=>{
      const start=performance.now();
      const trace=diagnostics?.request('ping');
      let failure;
      try {
        const response=await fetch('/api/ping',{cache:'no-store',signal:AbortSignal.timeout(3500),
          ...(trace&&{headers:{'X-Honeymoon-Trace':trace.id}})});
        trace?.headers(response);
        reachable=(local || navigator.onLine!==false) && response.status===204;
        if (!reachable) report?.fail('ping',connectionFailure({status:response.status}));
      } catch (error) {
        failure=error;
        reachable=false;
        report?.fail('ping',connectionFailure(error));
      } finally {
        trace?.finish(failure);
      }
      if (reachable) {
        report?.recover('ping');
        if (warmed) {
          const latency = Math.round(performance.now()-start);
          ping.textContent='Пинг '+latency+' мс';
          onLatency(latency);
        }
        if (startupStopped && autoReload) onRecover();
      } else {
        ping.textContent='Пинг —';
        onLatency(null);
      }
      const isWarm=warmed;
      warmed=reachable;
      paint();
      schedule(!reachable ? recoveryInterval : !isWarm ? 250 : active() ? 1250 : pingInterval);
      return reachable;
    })().finally(()=>{request=undefined;});
    return request;
  }

  function stream(online,why) {
    live=online;
    wasLive||=online;
    if (online) report?.recover('sse');
    else report?.fail('sse',{why});
    paint();
    if (!online) void check();
    else schedule(0);
  }

  function frames(rendered,now) {
    if (lastFrameSample===undefined) {
      lastFrameCount=rendered;
      lastFrameSample=now;
    } else if (now-lastFrameSample>=1000) {
      const value=Math.round((rendered-lastFrameCount)*1000/(now-lastFrameSample));
      fps.textContent=value+' FPS';
      lastFrameCount=rendered;
      lastFrameSample=now;
    }
  }

  retry.addEventListener('click',onRecover);
  addEventListener('online',()=>void check());
  addEventListener('offline',()=>{
    if (local) { void check(); return; }
    reachable=false;
    warmed=false;
    ping.textContent='Пинг —';
    report?.fail('ping',{why:'offline'});
    paint();
  });
  document.addEventListener('visibilitychange',()=>{
    lastFrameSample=undefined;
    if (!document.hidden) void check();
  });

  return {check,frames,stream,streamReady:()=>live===true,canMove:()=>live!==false && reachable!==false,
    setLocal(value) { local=value; void check(); },
    movementWaiting(waiting, terrain=false) {
      if (predictionPaused===waiting && terrainWaiting===terrain) return;
      predictionPaused=waiting;
      terrainWaiting=terrain;
      paint();
    },
    startupFailed(waitForServer) {
      startupStopped=true;
      autoReload=waitForServer;
      paint();
    }};
}
