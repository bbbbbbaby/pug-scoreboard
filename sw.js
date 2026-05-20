const CACHE_NAME = 'pug-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/icon-180x180.png',
  '/manifest.json',
];

// Install: pre-cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first per API, cache-first per assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET and Supabase API calls (always fresh)
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('giphy.com')) return;
  if (url.hostname.includes('fonts.googleapis.com')) return;

  // Avatars: cache-first (they don't change)
  if (url.pathname.startsWith('/avatars/')) {
    e.respondWith(
      caches.match(e.request)
        .then(cached => cached || fetch(e.request).then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return resp;
        }))
    );
    return;
  }

  // App shell: network-first with cache fallback
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request)
        .then(cached => cached || caches.match('/index.html'))
      )
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
        const existing = cls.find(c => c.url.startsWith(self.location.origin));
        if (existing) return existing.focus();
        return clients.openWindow(e.notification.data?.url || '/');
      })
  );
});

// Skip waiting message
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
