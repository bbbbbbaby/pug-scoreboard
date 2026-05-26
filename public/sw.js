// PUG Service Worker — versione statica, nessun placeholder
const CACHE = 'pug-v3';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) {
        if (k !== CACHE && k !== 'pug-avatars') return caches.delete(k);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.indexOf('supabase.co') !== -1) return;
  if (url.hostname.indexOf('googleapis.com') !== -1) return;
  if (url.hostname.indexOf('giphy.com') !== -1) return;
  if (url.hostname.indexOf('qrserver.com') !== -1) return;

  if (url.pathname.indexOf('/avatars/') === 0) {
    e.respondWith(
      caches.match(e.request).then(function(c) {
        return c || fetch(e.request).then(function(r) {
          var clone = r.clone();
          caches.open('pug-avatars').then(function(cache) { cache.put(e.request, clone); });
          return r;
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request).then(function(c) {
        return c || caches.match('/index.html');
      });
    })
  );
});

self.addEventListener('push', function(e) {
  if (!e.data) return;
  var d = { title: 'PUG', body: '' };
  try { d = e.data.json(); } catch (err) { d.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(d.title || 'PUG', {
      body: d.body || '',
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      vibrate: [200, 100, 200],
      tag: 'pug',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf(self.location.origin) === 0) return cs[i].focus();
      }
      return clients.openWindow('/');
    })
  );
});

self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
