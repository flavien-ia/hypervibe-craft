// plugin-place.mjs - Where this plugin lives, and what that changes for an update.
//
// An update moves the installed folder aside as a backup, then puts the new version in its
// place. That backup only lasts where the folder sits in a registry we know: a marketplace
// folder, `.../plugins/marketplaces/<marketplace>/<plugin name>`, the same test as the
// Enterprise migration (`hors_marketplace`).
//
// Claude Desktop 4.29 keeps the plugins it was given by upload in a registry of its own
// (`...\Claude-Data\...\rpm\<account>\<org>\plugin_<id>`), and tidies that folder by itself a
// few minutes after an update: every folder it does not know, the backup included, is deleted
// (Desktop bench of 28-29/10/2026, three backups out of three gone). Its Plugins screen also
// shows the version of the upload, never the one on disk. So, outside a marketplace folder, an
// update must not promise a backup, and on Desktop it says which version really runs.
//
// No I/O: only the path and the plugin's name are read.

import path from "node:path";

/**
 * @param {string} pluginRoot  the plugin's folder
 * @param {string} name        its name, from .claude-plugin/plugin.json
 * @returns {{place: "marketplace"|"desktop"|"hors_marketplace", backupKept: boolean, desktop: boolean}}
 */
export function placeDuPlugin(pluginRoot, name) {
  const racine = path.resolve(String(pluginRoot || ""));
  const mp = path.dirname(racine);
  if (path.basename(path.dirname(mp)) === "marketplaces" && path.basename(racine) === name) {
    return { place: "marketplace", backupKept: true, desktop: false };
  }
  const segments = racine.split(/[\\/]+/).map((s) => s.toLowerCase());
  const desktop = segments.includes("rpm") && /^plugin_[a-z0-9]+$/i.test(path.basename(racine));
  return { place: desktop ? "desktop" : "hors_marketplace", backupKept: false, desktop };
}
