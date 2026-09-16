// PUG Service Worker — auto-aggiornante
// Cambia SOLO questo numero a ogni rilascio importante: svuota le vecchie cache.
const CACHE = 'pug-v5';
const AVATARS = 'pug-avatars-v1';

// ─── INSTALL ──────────────────────────────────────────────
self.addEventListener('install', function () {
  // la nuova versione entra subito in servizio, senza aspettare
  self.skipWaiting();
});

// ─── ACTIVATE ─────────────────────────────────────────────
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE && k !== AVATARS) return caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
      .then(function () {
        // avvisa le schede aperte che c'e una versione nuova
        return self.clients.matchAll({ type: 'window' }).then(function (cs) {
          cs.forEach(function (c) { c.postMessage({ type: 'SW_UPDATED', cache: CACHE }); });
        });
      })
  );
});

// ─── FETCH ────────────────────────────────────────────────
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // mai intercettare i servizi esterni
  var host = url.hostname;
  if (host.indexOf('supabase.co') !== -1) return;
  if (host.indexOf('googleapis.com') !== -1) return;
  if (host.indexOf('gstatic.com') !== -1) return;
  if (host.indexOf('giphy.com') !== -1) return;
  if (host.indexOf('qrserver.com') !== -1) return;
  if (url.origin !== self.location.origin) return;

  // AVATAR: prima la cache (non cambiano quasi mai), con aggiornamento in sottofondo
  if (url.pathname.indexOf('/avatars/') === 0) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (r) {
          if (r && r.ok) {
            var clone = r.clone();
            caches.open(AVATARS).then(function (c) { c.put(req, clone); });
          }
          return r;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
    return;
  }

  // NAVIGAZIONE (apertura dell'app): SEMPRE prima la rete.
  // Cosi dopo un rilascio si vede subito la versione nuova.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (r) {
        var clone = r.clone();
        caches.open(CACHE).then(function (c) { c.put('/index.html', clone); });
        return r;
      }).catch(function () {
        return caches.match('/index.html').then(function (c) {
          return c || new Response(
            '<h1 style="font-family:sans-serif;padding:40px">Sei offline</h1>' +
            '<p style="font-family:sans-serif;padding:0 40px">Riprova quando torna la connessione.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  // TUTTO IL RESTO: prima la rete, la cache serve solo se sei offline
  e.respondWith(
    fetch(req).then(function (r) {
      if (r && r.ok && (r.type === 'basic')) {
        var clone = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, clone); });
      }
      return r;
    }).catch(function () {
      return caches.match(req).then(function (c) {
        return c || caches.match('/index.html');
      });
    })
  );
});

// ─── NOTIFICHE PUSH ───────────────────────────────────────
self.addEventListener('push', function (e) {
  if (!e.data) return;
  var d = { title: 'PUG', body: '' };
  try { d = e.data.json(); } catch (err) { d.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(d.title || 'PUG', {
      body: d.body || '',
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      vibrate: [200, 100, 200],
      tag: d.tag || 'pug',
      renotify: true,
      data: { url: d.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf(self.location.origin) === 0) {
          cs[i].focus();
          if ('navigate' in cs[i] && target !== '/') cs[i].navigate(target);
          return;
        }
      }
      return clients.openWindow(target);
    })
  );
});

// ─── MESSAGGI DALL'APP ────────────────────────────────────
self.addEventListener('message', function (e) {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'CLEAR_CACHE') {
    caches.keys().then(function (keys) {
      keys.forEach(function (k) { if (k !== AVATARS) caches.delete(k); });
    });
  }
});
