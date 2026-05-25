// Cache version — incrementa ad ogni deploy per forzare refresh
const CACHE_VERSION = 'pug-v' + Date.now();
const CACHE_NAME = CACHE_VERSION;

// Install: skip waiting subito per aggiornamenti immediati
self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

// Activate: elimina TUTTE le vecchie cache
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first per tutto (garantisce sempre contenuto fresco)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('googleapis.com')) return;

  // Avatars: cache-first (immagini statiche)
  if (url.pathname.startsWith('/avatars/')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open('pug-avatars').then(c => c.put(e.request, clone));
        }
        return resp;
      }))
    );
    return;
  }

  // App shell: network-first, cache come fallback offline
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok && url.hostname === self.location.hostname) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(c => c || caches.match('/index.html')))
  );
});

// Push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch(_) { data = { title:'PUG', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'PUG', {
      body: data.body || '',
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      vibrate: [200, 100, 200],
      tag: 'pug-notif',
      renotify: true,
      data: { url: self.location.origin },
    })
  );
});

// Notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true })
      .then(cls => {
        const w = cls.find(c => c.url.startsWith(self.location.origin));
        return w ? w.focus() : clients.openWindow('/');
      })
  );
});

// Skip waiting on message
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
