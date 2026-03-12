// Service Worker for daisy-gpt — caches compiler WASM binaries
// After first 60MB download, subsequent visits load from cache

const CACHE_NAME = 'daisy-gpt-compiler-v1';
const COMPILER_CDN = 'https://binji.github.io/wasm-clang/';

// Files to cache on first compiler load
const COMPILER_FILES = [
  'clang',
  'lld',
  'memfs',
  'sysroot.tar',
];

self.addEventListener('install', (event) => {
  // Don't pre-cache — compiler files are fetched on demand
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Only cache compiler CDN files
  if (!url.startsWith(COMPILER_CDN)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200) return response;

        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });

        return response;
      });
    })
  );
});
