import {connectionFailure} from './connection-report.mjs';

const pingInterval=5000;
const recoveryInterval=2000;
const positionFreshness=3500;
const streamFreshness=33_000;
const warningDelay=550;

export function createConnectionStatus({element,onRecover,onLatency,onRecovery,onStreamStale,active,report,diagnostics,
  now=()=>performance.now()}) {
  const fps=element('connection-fps'),ping=element('connection-ping');
  const alert=element('connection-alert'),message=element('connection-message'),retry=element('connection-retry');
  let reachable,live,wasPlayable=false,predictionPaused=false,terrainWaiting=false,startupStopped=false,autoReload=false,request,timer,warmed=false;
  let lastStreamAt=-Infinity,lastPositionAt=-Infinity,recovering=false,warningAt=Infinity;
  let lastFrameCount,lastFrameSample,local=false;

  const streamReady = (time=now()) => live===true && time-lastStreamAt<streamFreshness;
  const canMove = (time=now()) => streamReady(time) || time-lastPositionAt<positionFreshness;

  function loseStream(why) {
    live=false;
    diagnostics?.stream(false,why);
    report?.fail('sse',{why});
  }

  function paint(time=now()) {
    const stale=live===true && !streamReady(time);
    if (stale) loseStream('timeout');
    const needsRecovery=wasPlayable && (predictionPaused || !canMove(time));
    if (needsRecovery!==recovering) {
      recovering=needsRecovery;
      warningAt=recovering ? time+warningDelay : Infinity;
      onRecovery?.(recovering);
    }
    const text=startupStopped && !autoReload ? 'Сервер недоступен. Повторите подключение.' :
      startupStopped || (!wasPlayable && (reachable===false || live===false)) ? 'Сервер недоступен. Подключаемся повторно…' :
      terrainWaiting==='solo-unavailable' ? 'Район ещё не скачан. Подключите интернет для загрузки.' :
      terrainWaiting ? 'Загружаем ближайший участок…' :
      recovering && time>=warningAt ? (predictionPaused ? 'Восстанавливаем связь…' : 'Нестабильная связь. Восстанавливаем соединение…') : '';
    if (message.textContent!==text) message.textContent=text;
    if (alert.hidden!==!text) alert.hidden=!text;
    if (retry.hidden!==!startupStopped) retry.hidden=!startupStopped;
    if (stale) onStreamStale?.();
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
      let failure,status,serverAt;
      try {
        const response=await fetch('/api/ping',{cache:'no-store',signal:AbortSignal.timeout(3500),
          ...(trace&&{headers:{'X-Honeymoon-Trace':trace.id}})});
        trace?.headers(response);
        status=response.status;
        serverAt=Number(response.headers.get('X-Honeymoon-Server-Time'));
        reachable=(local || navigator.onLine!==false) && status===204;
        if (!reachable) report?.fail('ping',connectionFailure({status}));
      } catch (error) {
        failure=error;
        reachable=false;
        report?.fail('ping',connectionFailure(error));
      } finally {
        trace?.finish(failure);
        diagnostics?.ping({started:start,status,error:failure,reachable,serverAt});
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
    if (online) {
      live=true;
      wasPlayable=true;
      lastStreamAt=now();
      diagnostics?.stream(true);
      report?.recover('sse');
    } else loseStream(why);
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
    onLatency(null);
    paint();
  });
  document.addEventListener('visibilitychange',()=>{
    lastFrameSample=undefined;
    if (!document.hidden) void check();
  });

  return {check,frames,stream,streamReady,canMove,
    streamConnecting() {
      live=undefined;
      paint();
    },
    streamActivity() {
      if (!live) return;
      lastStreamAt=now();
      paint(lastStreamAt);
    },
    positionConfirmed() {
      wasPlayable=true;
      lastPositionAt=now();
      paint(lastPositionAt);
    },
    setLocal(value) { local=value; void check(); },
    movementWaiting(waiting, terrain=false) {
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
