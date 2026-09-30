/* ==========================================================================
   sw.js — service worker: makes the app usable with no connection.

   Strategy: network-first with a cache fallback.
     • Online  -> always the freshest file (no stale-bug while editing),
                  and the response is stored for later.
     • Offline -> the cached copy, falling back to the app shell for
                  navigations.

   Deliberately NOT intercepted:
     • anything cross-origin (the AI provider's /chat/completions calls)
     • non-GET requests
     • tests.html and uitest.html, which must always be live during a test run
   ========================================================================== */
(function () {
  'use strict';

  var CACHE = 'mash-todo-v1';
  var ASSETS = [
    './',
    './index.html',
    './styles.css',
    './store.js',
    './nlp.js',
    './ai.js',
    './app.js',
    './manifest.webmanifest',
    './icon.svg'
  ];

  self.addEventListener('install', function (event) {
    event.waitUntil(
      caches.open(CACHE)
        .then(function (cache) { return cache.addAll(ASSETS); })
        .then(function () { return self.skipWaiting(); })
    );
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        }));
      }).then(function () { return self.clients.claim(); })
    );
  });

  function isTestPage(pathname) {
    return /\/ui?t?ests?\.html$/.test(pathname);
  }

  self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;

    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;      // provider API + any CDN
    if (isTestPage(url.pathname)) return;                 // keep test pages live

    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('./index.html');
          return new Response('Offline and not cached: ' + url.pathname, {
            status: 504,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
    );
  });
}());
