const cacheName='honeymoon-offline-v1';
const fallback='/offline.html';
const entryPages=new Set(['/','/index.html','/client/index.html']);

self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(cacheName);
  await cache.add(new Request(fallback,{cache:'reload'}));
  await self.skipWaiting();
})()));

self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=await caches.keys();
  await Promise.all(names.filter(name=>name.startsWith('honeymoon-offline-') && name!==cacheName).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));

async function navigate(request) {
  try {
    const response=await fetch(request,{cache:'no-store'});
    if (![502,503,504].includes(response.status)) return response;
    return (await caches.match(fallback,{cacheName}))??response;
  } catch {
    return (await caches.match(fallback,{cacheName}))??new Response('Сервер Honeymoon недоступен.',
      {status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
}

self.addEventListener('fetch',event=>{
  if (event.request.mode!=='navigate' || event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if (url.origin===self.location.origin && entryPages.has(url.pathname)) event.respondWith(navigate(event.request));
});
