// Keeps the app available offline and always tries the newest version first.
const V = 'bt-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  const isPage = e.request.mode === 'navigate' || u.pathname === '/' || u.pathname === '/index.html';
  if (isPage) {
    // newest page first; if the network is slow or down, use the saved copy
    e.respondWith(
      Promise.race([fetch(e.request, { cache: 'no-store' }), new Promise((_, rej) => setTimeout(rej, 4000))])
        .then(r => { if (r && r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put('/index.html', cp)); } return r; })
        .catch(() => caches.match('/index.html').then(h => h || caches.match('/')))
    );
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r && r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
