const CACHE_NAME = "yuko-ai-shell-v4";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./features.js", "./manifest.webmanifest", "./favicon.svg"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("yuko-ai-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  const isShellAsset = SHELL.some((path) => new URL(path, self.registration.scope).pathname === url.pathname);
  if (!isShellAsset && request.mode !== "navigate") return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response && response.ok && isShellAsset) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  }).catch(() => caches.match("./index.html"))));
});
