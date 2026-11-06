"use strict";

// Intentionally network-only: live hands, accounts and table state are never cached.
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
