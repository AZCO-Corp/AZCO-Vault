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
// new version stages indefinitely.
//
// We force immediate apply via chrome.runtime.reload(), but only when
// the popup is NOT open -- otherwise the popup vanishes mid-interaction
// and the user's typing is lost. If a popup is open when the update
// stages, defer the reload, poll every few seconds (via chrome.alarms,
// which keeps the SW alive even when otherwise idle), and reload as
// soon as the popup closes. The user just sees the new version on next
// click of the icon.
//
// (Tried chrome.runtime.requestUpdateCheck() to force a poll on popup
// open. Silent no-op for policy-installed self-hosted extensions even
// though the docs don't flag it. Removed.)
const PENDING_RELOAD_ALARM = "azco-pending-reload";
let pendingUpdateVersion: string | null = null;

async function tryApplyPendingReload(): Promise<void> {
  if (!pendingUpdateVersion) {
    return;
  }
  const popups = await chrome.runtime.getContexts({
    contextTypes: ["POPUP" as chrome.runtime.ContextType],
  });
  if (popups.length === 0) {
    logService.info(`AZCO: applying staged update ${pendingUpdateVersion}`);
    chrome.runtime.reload();
  } else {
    // Popup is open; check again shortly. delayInMinutes minimum is
    // technically 0.5 in stable Chrome but Edge accepts smaller values
    // -- if it doesn't, the alarm just fires at 30s instead.
    void chrome.alarms.create(PENDING_RELOAD_ALARM, { delayInMinutes: 0.05 });
  }
}

chrome.runtime.onUpdateAvailable.addListener((details) => {
  pendingUpdateVersion = details?.version ?? "unknown";
  logService.info(`AZCO: update ${pendingUpdateVersion} staged, scheduling apply`);
  void tryApplyPendingReload();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PENDING_RELOAD_ALARM) {
    void tryApplyPendingReload();
  }
});

void (async () => {
  await azcoStaleEnvCleanup();
  const bitwardenMain = ((self as any).bitwardenMain = new MainBackground());
  await bitwardenMain.bootstrap().catch((error: unknown) => logService.error(error));
})();
