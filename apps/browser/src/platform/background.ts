import { ConsoleLogService } from "@bitwarden/common/platform/services/console-log.service";

import MainBackground from "../background/main.background";

const logService = new ConsoleLogService(false);

// AZCO self-heal: dev builds prior to 2026.3.11 leaked
// `devFlags.managedEnvironment.base = https://localhost:8080` from
// apps/browser/config/development.json into chrome.storage.local under
// `global_environment_environment`. Production builds no longer write it,
// but anyone whose extension ever ran a dev build still has the bad URL
// saved, so every login attempt POSTs to localhost (nothing listening),
// browser shows "Failed to fetch", request never reaches Vaultwarden.
//
// Surgically remove just that one storage key on SW startup if it points
// anywhere other than vw.azco.local. The env service then falls through
// to PRODUCTION_REGIONS[0] = vw.azco.local on next read. Email, vault
// data, and every other stored key are untouched.
async function azcoStaleEnvCleanup(): Promise<void> {
  try {
    const result = await chrome.storage.local.get("global_environment_environment");
    const entry = result?.global_environment_environment as { value?: string } | undefined;
    if (!entry?.value) {
      return;
    }
    const parsed = JSON.parse(entry.value) as { urls?: { base?: string } };
    const base = parsed?.urls?.base;
    if (base && !base.includes("vw.azco.local")) {
      await chrome.storage.local.remove("global_environment_environment");
      logService.info(`AZCO: cleared stale environment URL (${base})`);
    }
  } catch (e) {
    logService.error(e instanceof Error ? e : new Error(String(e)));
  }
}

// AZCO auto-update: Chrome's default behavior for self-hosted extensions
// is to download a new CRX when update.xml advertises a higher version,
// then *wait for the extension to become idle* before swapping. Bitwarden
// is rarely idle (alarms, vault sync, autofill content scripts) so the
// new version stages indefinitely -- e.g. 2026.3.13 active, 2026.3.14
// downloaded, neither dir removed. Force immediate apply via
// chrome.runtime.reload() the moment Chrome stages an update.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  logService.info(`AZCO: applying staged update ${details?.version}`);
  chrome.runtime.reload();
});

// Also actively poll whenever the popup wakes the SW. Bitwarden's popup
// communicates via chrome.runtime.sendMessage (one-shot), not connect()
// ports, so we hook onMessage instead. Any incoming message triggers a
// debounced update check -- Chrome's own throttle (~5min minimum between
// requestUpdateCheck calls) is the floor; our 60s gate avoids redundant
// API calls when many messages arrive in quick succession.
let lastUpdateCheck = 0;
chrome.runtime.onMessage.addListener(() => {
  const now = Date.now();
  if (now - lastUpdateCheck < 60_000) {
    return;
  }
  lastUpdateCheck = now;
  chrome.runtime.requestUpdateCheck((status) => {
    if (status === "update_available") {
      logService.info("AZCO: popup-triggered update check found new version, reloading");
      chrome.runtime.reload();
    }
  });
});

void (async () => {
  await azcoStaleEnvCleanup();
  const bitwardenMain = ((self as any).bitwardenMain = new MainBackground());
  await bitwardenMain.bootstrap().catch((error: unknown) => logService.error(error));
})();
