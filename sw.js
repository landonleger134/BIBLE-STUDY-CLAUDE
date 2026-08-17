// Minimal service worker — enables "Add to Home Screen" installability.
// Intentionally does no caching so the app always loads the latest deploy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', () => {}); // pass-through, required for installability
