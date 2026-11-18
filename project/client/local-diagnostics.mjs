export function recordLocalDiagnostics(canvas, snapshot) {
  function send(kind,message) {
    let details;
    try { details=snapshot(); } catch {}
    const body=JSON.stringify({kind,...details,...(message&&{message:String(message).slice(0,260)})});
    void fetch('/api/local-diagnostics',{method:'POST',headers:{'Content-Type':'application/json'},
      keepalive:true,signal:AbortSignal.timeout(2000),body}).catch(()=>{});
  }
  addEventListener('error',event=>send('browser-error',event.message));
  addEventListener('unhandledrejection',event=>send('browser-error',event.reason?.message));
  addEventListener('pagehide',()=>send('exit'));
  canvas.addEventListener('webglcontextlost',event=>{
    event.preventDefault();
    send('webgl-lost');
  });
  canvas.addEventListener('webglcontextrestored',()=>send('webgl-restored'));
  setInterval(()=>send('heartbeat'),15_000);
  send('heartbeat');
  return error=>send('worker-error',error?.message);
}
