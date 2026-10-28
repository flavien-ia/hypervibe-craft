"use client";

// Cloche de notifications avec pastille du nombre de non-lues + panneau déroulant
// listant les notifications (clic = marquer comme lu puis ouvrir le lien). À placer
// dans le header / la barre de navigation. /add-notification-center adapte les
// couleurs à la palette du projet.
//
// UI optimiste : la pastille et l'état lu/non-lu se mettent à jour immédiatement,
// la persistance part en arrière-plan (rollback si erreur).
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const utils = api.useUtils();

  // Temps réel sans polling : si /add-push-notification est installé, le
  // service worker rediffuse chaque push reçu aux onglets ouverts
  // (postMessage "hv:new-notification") et on invalide le compteur ici.
  // Sans service worker (pas de PWA/push), cet effet ne fait simplement rien.
  useEffect(() => {
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "hv:new-notification") {
        void utils.notifications.unreadCount.invalidate();
        void utils.notifications.list.invalidate();
      }
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, [utils]);

  // Pastille : filet de sécurité toutes les 5 min. Ne JAMAIS redescendre sous
  // 300 s : un poll plus court garde la base Neon éveillée en continu pour
  // chaque onglet actif (elle ne s'autosuspend qu'après 5 min sans requête).
  // Le retour sur l'onglet est déjà couvert par refetchOnWindowFocus (défaut
  // TanStack Query), et le temps réel par le push ci-dessus quand il existe.
  const unread = api.notifications.unreadCount.useQuery(undefined, {
    refetchInterval: 300_000,
  });
  // Liste : chargée seulement quand le panneau est ouvert.
  const list = api.notifications.list.useQuery({ limit: 20 }, { enabled: open });
  const items = list.data ?? [];

  const markOne = api.notifications.markRead.useMutation({
    onMutate: async ({ id }) => {
      await utils.notifications.unreadCount.cancel();
      await utils.notifications.list.cancel();
      const prevCount = utils.notifications.unreadCount.getData();
      const prevList = utils.notifications.list.getData({ limit: 20 });
      utils.notifications.unreadCount.setData(undefined, (c) => Math.max(0, (c ?? 0) - 1));
      utils.notifications.list.setData({ limit: 20 }, (old) =>
        old?.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      return { prevCount, prevList };
    },
    onError: (_e, _v, ctx) => {
      utils.notifications.unreadCount.setData(undefined, ctx?.prevCount);
      utils.notifications.list.setData({ limit: 20 }, ctx?.prevList);
    },
    onSettled: () => {
      void utils.notifications.unreadCount.invalidate();
      void utils.notifications.list.invalidate();
    },
  });

  const markAll = api.notifications.markAllRead.useMutation({
    onMutate: async () => {
      await utils.notifications.unreadCount.cancel();
      await utils.notifications.list.cancel();
      const prevCount = utils.notifications.unreadCount.getData();
      const prevList = utils.notifications.list.getData({ limit: 20 });
      utils.notifications.unreadCount.setData(undefined, 0);
      utils.notifications.list.setData({ limit: 20 }, (old) =>
        old?.map((n) => ({ ...n, read: true })),
      );
      return { prevCount, prevList };
    },
    onError: (_e, _v, ctx) => {
      utils.notifications.unreadCount.setData(undefined, ctx?.prevCount);
      utils.notifications.list.setData({ limit: 20 }, ctx?.prevList);
    },
    onSettled: () => {
      void utils.notifications.unreadCount.invalidate();
      void utils.notifications.list.invalidate();
    },
  });

  // Clic sur une notification : on garantit la persistance du "lu" AVANT de
  // naviguer (une navigation immédiate annulerait la requête en cours), puis on
  // ouvre le lien. L'UI, elle, est déjà à jour (optimiste).
  const openNotification = async (n: { id: string; url: string | null; read: boolean }) => {
    if (!n.read) {
      try {
        await markOne.mutateAsync({ id: n.id });
      } catch {
        // l'optimiste a déjà été rollback par onError ; on navigue quand même
      }
    }
    // Un lien de notification vient de la base : seul un chemin interne est suivi
    // (un seul / en tête, ni // ni /\). Une adresse javascript: ou un autre site
    // ne déclenche aucune navigation.
    if (n.url && /^\/(?![/\\])/.test(n.url)) window.location.assign(n.url);
  };

  const count = unread.data ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-9 cursor-pointer place-items-center rounded-md transition hover:bg-muted"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="size-5" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Clic en dehors = fermeture */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-border bg-background shadow-lg">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              {count > 0 && (
                <button
                  type="button"
                  onClick={() => markAll.mutate()}
                  className="cursor-pointer text-xs text-muted-foreground transition hover:text-foreground"
                >
                  Tout marquer comme lu
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {list.isLoading ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Chargement…</p>
              ) : items.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Aucune notification.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => void openNotification(n)}
                        className={`w-full cursor-pointer px-4 py-3 text-left transition hover:bg-muted/60 ${
                          n.read ? "" : "bg-muted/40"
                        }`}
                      >
                        <p className="text-sm font-medium text-foreground">{n.title}</p>
                        {n.body && <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
