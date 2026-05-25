const CACHE = 'pug-cache-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(
      ks.filter(k => k !== CACHE && k !== 'pug-avatars').map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.pathname.startsWith('/avatars/')) {
    e.respondWith(
      caches.match(e.request).then(c => c || fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open('pug-avatars').then(cache => cache.put(e.request, clone));
        return r;
      }))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then(c => c || caches.match('/index.html')))
  );
});

self.addEventListener('push', e => {
  if (!e.data) return;
  let d = { title: 'PUG', body: '' };
  try { d = e.data.json(); } catch (_) { d.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      vibrate: [200, 100, 200],
      tag: 'pug',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cs => {
      const w = cs.find(c => c.url.startsWith(self.location.origin));
      return w ? w.focus() : clients.openWindow('/');
    })
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
