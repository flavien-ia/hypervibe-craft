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

/**
 * Un chemin de ce site venu d'ailleurs (ici, le lien d'une notification), ou null. Lu par le
 * lecteur d'adresses du navigateur, jamais par un motif sur le texte brut : le navigateur retire
 * tabulations et retours à la ligne et lit `\` comme `/`, si bien que `/\t/evil.com` devient
 * `//evil.com`, un autre site. Un chemin qui commence encore par `//` une fois lu (`/.//evil.com`)
 * est refusé aussi. Une adresse `javascript:` a une autre origine : refusée.
 */
function internalPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const origin = self.location.origin;
    const target = new URL(raw, origin);
    if (target.origin !== origin || target.pathname.startsWith("//")) return null;
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Le lien d'une notification est un chemin de ce site ("/commandes/12"). Tout le reste (adresse
  // externe, "//hote", "/\t/hote", "javascript:") ouvre l'accueil : un clic n'envoie jamais vers
  // un autre site.
  const url = internalPath((event.notification.data as { url?: string })?.url) ?? "/";
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
