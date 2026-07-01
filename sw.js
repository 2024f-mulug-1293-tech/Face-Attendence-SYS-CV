/**
 * Service Worker — Face Attendance System
 * Caches app shell and face-api models for offline use
 */

const CACHE_NAME    = 'fas-v3';
const MODEL_CACHE   = 'fas-models-v1';

// App shell files to cache immediately
const SHELL_FILES = [
  './',
  './index.html',
  './login.html',
  './css/style.css',
  './js/supabase-config.js',
  './js/auth.js',
  './js/db.js',
  './js/face.js',
  './js/ui.js',
  './js/app.js',
  './manifest.json'
];

// face-api model files to cache (large, but only downloaded once)
const MODEL_FILES = [
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/tiny_face_detector_model-shard1',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/tiny_face_detector_model-weights_manifest.json',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/face_landmark_68_model-shard1',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/face_landmark_68_model-weights_manifest.json',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/face_recognition_model-shard1',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/face_recognition_model-shard2',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model/face_recognition_model-weights_manifest.json'
];

// ── Install: cache shell files ─────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Shell cache failed:', err))
  );
});

// ── Activate: clean old caches ─────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== MODEL_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache, fallback to network ───────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Firebase requests — always network (real-time data)
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase.googleapis.com') ||
      url.includes('identitytoolkit.googleapis.com') ||
      url.includes('securetoken.googleapis.com')) {
    return; // Let browser handle it normally
  }

  // face-api models — cache-first (large files, rarely change)
  if (url.includes('vladmandic/face-api') || url.includes('face-api')) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) {
              const resClone = response.clone();
              cache.put(event.request, resClone);
            }
            return response;
          });
        })
      )
    );
    return;
  }

  // App shell — Network-first with cache fallback
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok && event.request.method === 'GET') {
        const resClone = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, resClone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request).then(cached => {
        if (cached) return cached;
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
