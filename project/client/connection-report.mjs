const limit = 16;
const maxAge = 24 * 60 * 60 * 1000;
const opened = { ping:'ping_recovered', sse:'sse_open', movement:'movement_recovered', storage:'storage_recovered' };
const failed = { ping:'ping_failed', sse:'sse_error', movement:'movement_failed', storage:'storage_failed' };

export function connectionFailure(error) {
  if (globalThis.navigator?.onLine === false) return { why:'offline' };
  if (error?.name === 'TimeoutError') return { why:'timeout' };
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
    return { why:'http', status:error.status };
  }
  return { why:'network' };
}

export function createConnectionReport({
  clock = Date.now, monotonic = () => performance.now(), send = body => fetch('/api/connection-report', {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body),
    keepalive:true, signal:AbortSignal.timeout(4000),
  }),
} = {}) {
  const incidents = new Map();
  let queue = [], scope, timer, sending = false, retry = 0, disabled = false, sseOpened = false;
  let retryAfter = 0;

  function persist() {
    try {
      if (queue.length) sessionStorage.setItem(scope, JSON.stringify(queue));
      else sessionStorage.removeItem(scope);
    } catch { /* sessionStorage may be unavailable */ }
  }

  function schedule(delay) {
    if (!scope || disabled || sending || !queue.length) return;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), Math.max(delay, retryAfter - monotonic()));
  }

  async function flush() {
    queue = queue.filter(event => event?.at >= clock() - maxAge);
    if (!queue.length) { persist(); return; }
    const batch = queue.slice();
    sending = true;
    try {
      const { status } = await send({ events:batch });
      if (status === 204 || status === 400 || status === 413) {
        queue = queue.filter(event => !batch.includes(event));
        persist();
        retry = 0;
        retryAfter = 0;
      } else if (status === 401 || status === 403 || status === 404 || status === 501) {
        disabled = true;
      } else if (status === 429) {
        retryAfter = monotonic() + 30_000;
      } else {
        retryAfter = monotonic() + Math.min(30_000, 5000 * ++retry);
      }
    } catch {
      retryAfter = monotonic() + Math.min(30_000, 5000 * ++retry);
    } finally {
      sending = false;
      schedule(250);
    }
  }

  function add(event) {
    if (!scope || disabled) return;
    queue = [...queue.slice(1 - limit), { ...event, at:clock() }];
    persist();
    schedule(100);
  }

  return {
    enable(uid) {
      if (scope || typeof uid !== 'string' || !uid) return;
      scope = `honeymoon-connection-report:${uid}`;
      try {
        const stored = JSON.parse(sessionStorage.getItem(scope));
        if (Array.isArray(stored)) queue = stored.slice(-limit);
      } catch { /* continue without persisted reports */ }
      schedule(100);
    },
    fail(channel, { why, status } = {}) {
      if (!scope || !Object.hasOwn(failed,channel)) return;
      const previous = incidents.get(channel);
      if (previous && previous.why === why && previous.status === status) return;
      incidents.set(channel, { why, status, start:previous?.start ?? monotonic() });
      add({ kind:failed[channel], ...(why && { why }), ...(status && { status }) });
    },
    recover(channel) {
      if (!scope || !Object.hasOwn(opened,channel)) return;
      const previous = incidents.get(channel);
      if (!previous && (channel !== 'sse' || sseOpened)) return;
      incidents.delete(channel);
      if (channel === 'sse') sseOpened = true;
      const duration = previous && Math.min(maxAge, Math.max(0, Math.round(monotonic() - previous.start)));
      add({ kind:opened[channel], ...(Number.isInteger(duration) && { durationMs:duration }) });
    },
  };
}
