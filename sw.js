// ─── VERSION ─────────────────────────────────────────────
// Cambia questo numero ad ogni deploy per forzare aggiornamento
const SW_VERSION = '__SW_VERSION__';
const CACHE_SHELL = 'pug-shell-' + SW_VERSION;
const CACHE_AVATARS = 'pug-avatars-v1';

// Asset da cachare subito (app shell)
const SHELL_ASSETS = ['/', '/index.html'];

// ─── INSTALL ─────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then(c => c.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting()) // attiva subito
  );
});

// ─── ACTIVATE ────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_SHELL && k !== CACHE_AVATARS)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // prendi controllo di tutte le tab
      .then(() => {
        // Notifica le tab che il nuovo SW è attivo
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
        });
      })
  );
});

// ─── FETCH ───────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Supabase e API esterni: sempre network, mai cache
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('googleapis.com')) return;
  if (url.hostname.includes('giphy.com')) return;
  if (url.hostname.includes('qrserver.com')) return;

  // Avatars: cache-first (cambiano raramente)
  if (url.pathname.startsWith('/avatars/')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_AVATARS).then(c => c.put(e.request, clone));
          }
          return resp;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // Asset con hash Vite (/assets/...): cache-first (hash garantisce freshness)
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_SHELL).then(c => c.put(e.request, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // App shell (index.html e route SPA): network-first, cache come fallback offline
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok && url.hostname === self.location.hostname) {
          const clone = resp.clone();
          caches.open(CACHE_SHELL).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() =>
        caches.match(e.request)
          .then(c => c || caches.match('/index.html'))
          .then(c => c || new Response('Offline', { status: 503 }))
      )
  );
});

// ─── PUSH NOTIFICATIONS ──────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let d = { title: 'PUG', body: '' };
  try { d = e.data.json(); } catch(_) { d.body = e.data.text(); }
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

// ─── MESSAGES ────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
