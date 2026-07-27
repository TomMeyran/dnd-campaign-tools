// RETIRED service worker.
//
// This used to cache nocropi.html for offline use, but it served the page
// cache-first with no expiry, which made the atlas (and anything relying on a
// fresh page) show stale content indefinitely. The server now sends correct
// cache headers, so no service worker is needed.
//
// This version does the opposite of caching: on activation it deletes every
// cache, unregisters itself, and reloads the pages it controls so they load
// fresh from the network. After that it is gone for good.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => { try { c.navigate(c.url); } catch (_) {} });
    } catch (_) {}
  })());
});

// No fetch handler — every request goes straight to the network.
