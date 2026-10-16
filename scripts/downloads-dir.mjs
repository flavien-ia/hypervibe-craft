// downloads-dir.mjs - The person's real downloads folder (3.4.13), where a file meant for them alone
// goes (an admin password, never shown in the conversation). Windows lets that folder live elsewhere
// (in a Dropbox folder, say) and records where in the registry: ~/Downloads may then be an empty
// leftover nobody opens. Read in the registry on Windows, with xdg-user-dir on Linux, ~/Downloads on
// macOS; the home folder when none of them exists.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The known folder of downloads, under the key Windows keeps the user's folders in. */
const KNOWN_FOLDER = "{374DE290-123F-4565-9164-39C4925E467B}";
const USER_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/** %NAME% expanded the way Windows does, from the given environment (names in any case). */
export function expandWindows(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key ? env[key] : whole;
  });
}

/** The folder, read as the system declares it; `run` and `exists` stand in for the system in recettes. */
export function downloadsDir({ platform = process.platform, env = process.env, home = homedir(), run = spawnSync, exists = existsSync } = {}) {
  const candidates = [];
  if (platform === "win32") {
    const r = run("reg", ["query", USER_FOLDERS, "/v", KNOWN_FOLDER], { encoding: "utf8", windowsHide: true });
    const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(r?.stdout ?? ""));
    if (r?.status === 0 && m) candidates.push(expandWindows(m[1].trim(), env));
  } else if (platform === "linux") {
    const r = run("xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8" });
    const dir = String(r?.stdout ?? "").trim();
    if (r?.status === 0 && dir && dir !== home) candidates.push(dir);
  }
  candidates.push(join(home, "Downloads"));
  return candidates.find((d) => exists(d)) ?? home;
}
