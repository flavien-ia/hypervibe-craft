// Notifications push : bloc inséré par /add-push-notification dans le service
// worker créé par /add-pwa (src/app/sw.ts), juste après le marker
// "hypervibe:push-handlers". Ne pas dupliquer si déjà présent.
self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string } = {};
  try {
    data = (event.data?.json() ?? {}) as { title?: string; body?: string; url?: string };
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title ?? "__APP_NAME__";
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: data.body ?? "",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: data.url ?? "/" },
      }),
      // Rediffuser le push aux onglets ouverts : si le centre de notifications
      // (/add-notification-center) est installé, sa cloche écoute ce message et
      // invalide son compteur → badge à jour en temps réel, sans polling
      // agressif (qui garderait la base Neon éveillée, autosuspend 5 min).
      // Sans cloche, ce postMessage est simplement ignoré.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients) client.postMessage({ type: "hv:new-notification" });
        }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Le lien d'une notification est un chemin interne ("/commandes/12"). Tout le reste (adresse
  // externe, "//hote", "javascript:") ouvre l'accueil : un clic n'envoie jamais vers un autre site.
  const raw = (event.notification.data as { url?: string })?.url;
  const url = raw && /^\/(?![/\\])/.test(raw) ? raw : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            void client.focus();
            if ("navigate" in client) void client.navigate(url);
            return;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
