const pingInterval=5000;
const recoveryInterval=2000;

export function createConnectionStatus({element,onRecover}) {
  const fps=element('connection-fps'),ping=element('connection-ping');
  const alert=element('connection-alert'),message=element('connection-message'),retry=element('connection-retry');
  let reachable,live,wasLive=false,startupStopped=false,autoReload=false,request,timer,warmed=false;
  let lastFrameCount,lastFrameSample;

  function paint() {
    const text=startupStopped && !autoReload ? 'Сервер недоступен. Повторите подключение.' :
      startupStopped || (!wasLive && (reachable===false || live===false)) ? 'Сервер недоступен. Подключаемся повторно…' :
      (live===false || reachable===false ? 'Связь с сервером прервана. Восстанавливаем соединение…' : '');
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
      try {
        const response=await fetch('/api/ping',{cache:'no-store',signal:AbortSignal.timeout(3500)});
        reachable=navigator.onLine!==false && response.status===204;
      } catch {reachable=false;}
      if (reachable) {
        if (warmed) ping.textContent='Пинг '+Math.round(performance.now()-start)+' мс';
        if (startupStopped && autoReload) onRecover();
      } else ping.textContent='Пинг —';
      const isWarm=warmed;
      warmed=reachable;
      paint();
      schedule(!reachable?recoveryInterval:isWarm?pingInterval:250);
      return reachable;
    })().finally(()=>{request=undefined;});
    return request;
  }

  function stream(online) {
    live=online;
    wasLive||=online;
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
    reachable=false;
    warmed=false;
    ping.textContent='Пинг —';
    paint();
  });
  document.addEventListener('visibilitychange',()=>{
    lastFrameSample=undefined;
    if (!document.hidden) void check();
  });

  return {check,frames,stream,canMove:()=>live!==false && reachable!==false,
    startupFailed(waitForServer) {
      startupStopped=true;
      autoReload=waitForServer;
      paint();
    }};
}
