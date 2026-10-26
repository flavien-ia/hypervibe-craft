// The interactive table of the admin page for users and their roles. Its data comes from
// adminUsers.*, which checks isAdmin() on every call; the page that renders it (page.tsx)
// checks first, with requireAdmin().

"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { ROLES, ROLE_LABELS, type Role } from "~/lib/roles";

export function UsersTable() {
  const utils = api.useUtils();
  const { data: rows, isLoading } = api.adminUsers.list.useQuery();
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState<Role | "all">("all");
  const [multiRole, setMultiRole] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const setRolesMutation = api.adminUsers.setRoles.useMutation({
    onSuccess: () => utils.adminUsers.list.invalidate(),
    onSettled: () => setSavingId(null),
  });

  const filtered = (rows ?? []).filter((u) => {
    const matchesSearch =
      !search ||
      (u.email ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (u.name ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesRole =
      filterRole === "all" ||
      (Array.isArray(u.roles) && u.roles.includes(filterRole));
    return matchesSearch && matchesRole;
  });

  function handleSingleChange(userId: string, role: Role) {
    setSavingId(userId);
    setRolesMutation.mutate({ userId, roles: [role] });
  }

  function handleMultiToggle(userId: string, currentRoles: Role[], role: Role, checked: boolean) {
    setSavingId(userId);
    const next = checked
      ? Array.from(new Set([...currentRoles, role]))
      : currentRoles.filter((r) => r !== role);
    setRolesMutation.mutate({ userId, roles: next });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Utilisateurs et rôles</h1>
        <p className="text-sm text-muted-foreground">
          Liste de tous les comptes utilisateurs et leurs rôles. Cliquez pour modifier.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Rechercher (email, nom)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border px-3 py-2 text-sm"
        />
        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value as Role | "all")}
          className="rounded-lg border px-3 py-2 text-sm cursor-pointer"
        >
          <option value="all">Tous les rôles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={multiRole}
            onChange={(e) => setMultiRole(e.target.checked)}
            className="cursor-pointer"
          />
          Mode multi-rôle
        </label>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun utilisateur trouvé.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Utilisateur</th>
                <th className="px-4 py-2 text-left font-semibold">Email</th>
                <th className="px-4 py-2 text-left font-semibold">Rôle(s)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const userRoles = (Array.isArray(u.roles) ? u.roles : []) as Role[];
                const single = userRoles[0] ?? ROLES[0];
                const isSaving = savingId === u.id;
                return (
                  <tr key={u.id} className="border-t">
                    <td className="px-4 py-2">{u.name ?? "(sans nom)"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{u.email}</td>
                    <td className="px-4 py-2">
                      {multiRole ? (
                        <div className="flex flex-wrap gap-3">
                          {ROLES.map((r) => (
                            <label key={r} className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                disabled={isSaving}
                                checked={userRoles.includes(r)}
                                onChange={(e) =>
                                  handleMultiToggle(u.id, userRoles, r, e.target.checked)
                                }
                                className="cursor-pointer"
                              />
                              <span className="text-xs">{ROLE_LABELS[r]}</span>
                            </label>
                          ))}
                        </div>
                      ) : (
                        <select
                          value={single}
                          disabled={isSaving}
                          onChange={(e) => handleSingleChange(u.id, e.target.value as Role)}
                          className="rounded-lg border px-2 py-1 text-sm cursor-pointer disabled:opacity-50"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      )}
                      {isSaving && (
                        <span className="ml-2 text-xs text-muted-foreground">Sauvegarde...</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
