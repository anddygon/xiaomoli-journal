const scope = self.registration.scope;
const cachePrefix = 'xiaomoli-pages:' + encodeURIComponent(scope) + ':';
const cacheName = cachePrefix + '2026-11-14.5';
const assets = [
  'index.html','manifest.webmanifest','app.js','app.css','entry.js','entry.css',
  'photo-compress.js','backup.js','legacy.js','git-family-ui.js','git-family-remote.js','git-family-sync.js','icons.js','storage.js','jasmine.webp',
  'icon-192.png','icon-512.png','apple-touch-icon.png'
];
const urls = new Set(assets.map(file => new URL(file,scope).href));
const indexURL = new URL('index.html',scope).href;
const basePath = new URL(scope).pathname;
const indexPath = new URL(indexURL).pathname;

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(cacheName);
    await cache.addAll([...urls].map(url=>new Request(url,{cache:'reload'})));
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const old=(await caches.keys()).filter(key=>key.startsWith(cachePrefix) && key!==cacheName);
    await Promise.all(old.map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET' || url.origin!==self.location.origin || request.headers.has('range'))return;
  const documentRequest=request.mode==='navigate' && (url.pathname===basePath || url.pathname===indexPath);
  if(!documentRequest && !urls.has(url.href))return;
  event.respondWith((async()=>{
    const cache=await caches.open(cacheName);
    return await cache.match(documentRequest?indexURL:url.href) || fetch(request);
  })());
});
