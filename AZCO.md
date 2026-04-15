# AZCO Vault — fork notes

Private fork of `bitwarden/clients` that turns the Bitwarden desktop
app into **AZCO Vault**, backed by a self-hosted Vaultwarden server,
with AZCO-specific features layered on top.

- `origin` → `https://github.com/AZCO-Corp/AZCO-Vault` (this repo)
- `upstream` → `https://github.com/bitwarden/clients` (the real Bitwarden)
- Working branch: `azco/rebrand` — every AZCO change is a discrete
  commit on top of a clean `main` so rebases against upstream stay
  tractable.
- Local clone: `C:\AZCO-BitWarden` on `ASMB-LT01` (Windows). The
  Electron build must run on Windows because `desktop_native` is a
  Rust NAPI module that targets the host OS.

The upstream README is preserved at `README.md`. This file describes
only what AZCO changes and how to work with the fork.

## What the fork adds

### 1. Share vault items as timed links (the headline feature)

**Desktop** — `apps/desktop/src/vault/app/vault/item-footer.component.*`

Every vault item in "view" mode gets a share button next to Edit. Click
it → a dialog lets you pick:

- **Expiration**: 1 hour / 1 day / 7 days / 14 days / 30 days
- **Audience**: "Anyone with the link" or "Only specific people…"
  (email list is UI-only for v2; real email-gated access is a v3
  follow-up that needs a proxy service — see _Roadmap_).
- **Can only be viewed one time** toggle.

On confirm the desktop client:

1. Reads the decrypted cipher from vault state and formats a text
   body depending on the cipher type — logins emit
   name / URL / username / password / TOTP, cards emit cardholder /
   brand / number / expiry / CVV, identities emit full name + contact +
   address block, SSH keys emit public/private/fingerprint, and secure
   notes fall through to just notes. Empty fields are suppressed.
2. Wraps the body in a `SendView` and saves it with the standard
   `sendService.encrypt → sendApiService.save` pipeline (the same path
   the stock "new Send" form uses).
3. Rewrites the resulting URL from the underlying Vaultwarden host
   to `https://share.azcocorp.com/#/<accessId>/<urlB64Key>` so
   recipients never see `vw.securusconverting.com`.
4. Copies the URL to the clipboard and shows a success toast with
   the expiry + view-once state.

### 2. `azco-share-viewer/` — the recipient-facing service

A minimal `nginx:1.27-alpine` container that serves a single-page
vanilla-JS viewer and reverse-proxies exactly one endpoint
(`POST /api/sends/access/{id}`) to the upstream Vaultwarden. It runs
on `azco26` behind a Cloudflare tunnel mapped to `share.azcocorp.com`.

Key points:

- The Send decryption key lives in the URL fragment (`#…`) and never
  reaches any server. Browsers don't forward fragments — the viewer's
  own backend sees only encrypted ciphertext on its way to VW and
  back.
- The browser runs HKDF-SHA256 over the URL key (salt
  `bitwarden-send`, info `send`, 64 bytes → first 32 enc, last 32
  mac), verifies HMAC-SHA-256 over `iv || ciphertext`, and
  AES-256-CBC decrypts the body. Bit-for-bit compatible with
  `libs/key-management/src/key.service.ts :: makeSendKey`.
- **TOTP** is rendered as a **live rolling 6-digit code** computed
  client-side from the secret — the raw TOTP secret or `otpauth://`
  URL never shows on screen. Countdown bar goes red in the last 5
  seconds.
- URL-labelled fields render as clickable blue links with
  mid-ellipsis truncation and a full-URL title tooltip.
- Password and CVV rows are masked with a Show/Hide toggle.
- Hardening: CSP, HSTS, X-Frame-Options DENY, Referrer-Policy
  no-referrer, Permissions-Policy, static allow-list, HTTP method
  allow-list, rate limit (10 req/min per IP with burst 20 on the
  Send access proxy), `proxy_ssl_verify on` against the container's
  CA bundle, responses hide upstream Set-Cookie headers.
- Deployed at `127.0.0.1:8329` on `azco26`, fronted by a Cloudflare
  tunnel. See `azco-share-viewer/README.md` for the runbook,
  cache-busting, and the complete threat model.

### 3. Collection admin from the desktop app

`apps/desktop/src/vault/app/vault-v3/vault-filter/collection-admin-dialog/`

The "+" add-item menu in the header has a new **Collection** entry
(gated on `isAdmin || isOwner || canCreateNewCollections` for at
least one of your orgs). It opens a dialog that lets admins:

- **Create** a collection: pick organization (if you have more than
  one eligible), pick a parent collection from a dropdown for
  nesting, type a leaf name; submission builds the final slash-
  separated name. No more manually typing `Parent/Child`.
- **Rename** — edit mode refetches the full `CollectionAdminView`
  from the server so existing member/group permissions prefill
  correctly (the sidebar's `CollectionView` tree strips those fields
  by design).
- **Manage members** — per-row permission dropdown (No access, Can
  view, Can view (hide passwords), Can edit, Can edit (hide
  passwords), Can manage). The creating admin is always force-
  included with Manage so `updateLocalCollections` doesn't
  accidentally delete the collection from the local cache when the
  server returns `assigned=false`.
- **Manage groups** — same table format, hidden when the org has
  zero groups. Fetched via a direct `GET /api/organizations/{id}/groups/details`
  since Bitwarden's `GroupApiService` lives only in `apps/web`.
- **Delete** — confirmation dialog shows the current cipher count
  ("This collection currently holds 12 items — they will stay in the
  organization and move to the root listing"), and the cipher count
  is fetched via `cipherService.cipherViews$` filtered by
  `collectionIds`.

All create/update/delete calls trigger a `syncService.fullSync(true)`
so the sidebar tree updates immediately instead of waiting on a
manual reload.

**Sidebar tree layout** — collections are rendered inline under their
parent organization (not in a separate Collections group), using the
existing `app-collection-filter` component recursively so nested
collections (`Members/Frontend`, etc.) expand properly. Each
collection row gets a pencil edit affordance on hover for admins.

**Legacy vault layout** — this app actually runs the pre-milestone-3
layout by default because `DesktopUiMigrationMilestone3` is not set
by Vaultwarden. The + menu + Collection wiring is duplicated in
`vault-orig.component` + `vault-items-v2.component.html` so it works
in both the v3 and legacy paths.

### 4. Drag-and-drop cipher → collection move

Any user with write access to a cipher can drag it from the item
list onto a collection in the sidebar. A confirmation dialog summarises:

- Which current collections the item will leave
- Who on the target collection will gain access (members + groups,
  best-effort; falls back to a generic summary for non-admins)
- A reminder that the item stays in the same organization
- An undo hint

On confirm, `cipherView.collectionIds` is set to `[target]` and
`cipherService.encrypt → saveCollectionsWithServer → syncService.fullSync`
applies the change. Cross-org drops and personal-vault drops are
rejected with specific error toasts.

### 5. Brand + UX polish

- Window title, package identity, productName, tray tooltip, About
  dialog, first menu label, and the shared `BitwardenLogo` /
  `PasswordManagerLogo` SVGs are all rebranded to AZCO Vault / the
  AZCO wordmark. The fork runs with its own
  `%APPDATA%\AZCO Vault\` user-data dir and coexists with the
  official Bitwarden desktop app.
- Side nav defaults to its fully-expanded width (24rem, the previous
  max) so fresh userData dirs start with labels visible.
- `Ctrl+Shift+I` DevTools is force-enabled in fork builds (Bitwarden's
  menu has no `toggleDevTools` role, so the keybinding is otherwise
  dead in production Electron).
- `vw.securusconverting.com` → fork-local route for
  `POST /identity/accounts/prelogin/password` (a new 2026.4 endpoint
  Vaultwarden 1.35.2 doesn't implement yet). The request and response
  shapes are identical to the classic
  `POST /api/accounts/prelogin`, so the compatibility patch just
  redirects. Fork-local, do not upstream.
- Nav-logo top padding, anchor height, and SVG inset tightened to suit
  the wide AZCO wordmark.

## Commit history (most recent first)

```
c25041d42f azco: tighten sidebar logo spacing
46d80f89ad azco: drag-and-drop cipher → collection move with confirmation
ec567e846d azco: collection admin v2 — org picker, parent nesting, groups, + menu
63ce9cafa2 azco: collection admin dialog (create/rename/delete + member access)
ee51a2c140 azco: default side nav fully expanded, nest collections under orgs
baf6e4a3ca azco: swap lock/login wordmark, viewer TOTP + URL polish, hardening pass
c633b18afc azco: swap Bitwarden logos for AZCO brand, add viewer branding
49c95b10c8 azco: window title, share.azcocorp.com URL, nginx resolver
7d9fc4f7b6 azco: scaffold Docker share viewer (azco-share-viewer/)
6854d1fc3f azco: rebrand desktop app as AZCO Vault
c544a9007b azco: format share body per cipher type
c27f30d15c azco: add share-link configuration dialog (v2)
cae7407df0 azco: share vault item as a timed Bitwarden Send link
8a226aa570 azco: route password prelogin to classic /api endpoint (vw-compat)
533f3bc739 azco: force-enable DevTools in fork builds
0e336ef398 azco: rebrand desktop app as AZCO-Bitwarden
```

## Working with the fork

### Build prerequisites (Windows + WSL)

- Node 22 via `fnm` (don't use the system Node 24)
- Visual Studio Build Tools 2022 with the C++ workload — `node-gyp`
  native modules (`keytar`, `argon2`, `desktop_napi`)
- Rust toolchain 1.94.1 (pinned in
  `apps/desktop/desktop_native/rust-toolchain.toml`)
- Python 3, git, git-lfs

Helper scripts live in `/root/scripts/bw-*.ps1` on ASMB-LT01:

```bash
powershell.exe -ExecutionPolicy Bypass -File /root/scripts/bw-rebuild-all.ps1
powershell.exe -ExecutionPolicy Bypass -File /root/scripts/bw-launch.ps1
```

Use `npm start` inside `apps/desktop` (NOT `npm run electron` — that's
a webpack dev watcher that wipes `./build` and tends to fight the
one-shot workflow).

### Staying current with upstream

```
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout azco/rebrand && git rebase main
# resolve conflicts, rebuild, test, push with force-with-lease:
git push --force-with-lease origin azco/rebrand
```

The vw-compat prelogin patch and the nav-logo padding edit are the
two that touch files most likely to churn upstream — watch those.

## Security notes

**Desktop app** inherits Bitwarden's threat model. The share feature
only uses public `SendView` / `SendApiService` APIs and reprompts for
master password on share creation (same code path as delete / clone),
so a locked vault can't be silently exfiltrated.

**Share viewer** — see `azco-share-viewer/README.md` for the full
deployment threat model. Highlights:

- Decryption key lives only in the URL fragment; browsers don't
  forward fragments, so the viewer's backend, the Cloudflare tunnel,
  and Vaultwarden never see it.
- The viewer reverse-proxies exactly one endpoint
  (`POST /api/sends/access/{id}`); everything else is either a
  static asset or a 404.
- HMAC-SHA-256 is verified over `iv || ciphertext` BEFORE any
  AES-256-CBC decryption.
- Passwords and CVV are masked with Show/Hide; TOTP renders the
  rolling code, never the secret.
- 10 req/min per-IP rate limit on the proxy (burst 20).
- `proxy_ssl_verify on` against the container CA bundle.

## Roadmap

- **Custom icons on vault items** — let users upload a per-item icon
  that overrides the favicon in the desktop client AND carries
  through to the share viewer. Next in the queue — see
  `docs/handoff-custom-icons.md` for the full implementation plan.
- **v3 — email-gated shares** — `share.azcocorp.com` becomes an AZCO-
  hosted identity gate: recipient enters their email, the proxy
  checks an allow-list stored with the Send, issues a short-lived
  2FA code via Graph/Exchange, and only reveals the underlying Send
  URL after the code matches. No Vaultwarden changes needed — the
  logic lives entirely in a new middleware layer in front of the
  existing Send access proxy.
- Firewall `vw.securusconverting.com` to only accept requests from
  the viewer's egress IP + internal LAN. Safe to do once the viewer
  is stable; it's the only internet-facing client path now.
- File-type Sends in the viewer (currently only text Sends are
  rendered; files fall through to an unsupported error).
- Configurable share base URL (currently hard-coded to
  `https://share.azcocorp.com`).

## Known issues / gotchas

- **`process_isolation` DACL** — the AZCO Vault process applies a
  DACL via `desktop_core::process_isolation` that blocks
  `Stop-Process -Force`. The only way to kill a running instance is
  to close the window manually.
- **WSL-launched Electron windows share the user's desktop session**
  but Chromium sometimes defers to the official Bitwarden instance
  via `app.requestSingleInstanceLock()` — the AZCO Vault rename
  (different productName → different user-data dir and app name)
  fixes this.
- **Legacy vault layout** is the default for Vaultwarden-backed
  clients (the `DesktopUiMigrationMilestone3` feature flag isn't set
  server-side). Any change that touches the vault items list needs
  to be applied to both `vault.component` (v3, under
  `apps/desktop/src/vault/app/vault-v3/`) _and_ `vault-orig.component`
  - `vault-items-v2.component` so both paths work.
- **`CollectionAdminService`** has no global provider in the desktop
  app's `services.module.ts`; it's only registered in `apps/web`.
  The dialogs that need it (collection admin, collection filter for
  member counts) declare a `useFactory` provider at the component
  level that wires `DefaultCollectionAdminService` by hand because
  the default class isn't `@Injectable`-decorated.
- **`canEditAnyCollection`** is a narrow gate — it requires the org's
  `allowAdminAccessToAllCollectionItems` setting, which Vaultwarden
  returns as `false`. Use `isAdmin || isOwner || canCreateNewCollections`
  instead for admin gating, otherwise real org admins see no
  affordances.
- **Vaultwarden `DOMAIN` env var** was previously set to the wrong
  host (`https://vw.securuspackaging.com` instead of
  `vw.securusconverting.com`) in
  `/home/vaultwarden/docker-compose.yml` on `azco26_old`. Fixed
  2026-04-15. Any email VW sends (password reset, invites, 2FA)
  should now land at the correct host.

## File map (AZCO-specific only)

```
AZCO.md                               # this file
azco-share-viewer/                    # Docker share viewer
├── Dockerfile
├── README.md
├── nginx.conf
└── public/
    ├── app.js
    ├── index.html
    ├── logo-blue.svg
    └── styles.css
docs/
└── handoff-custom-icons.md           # next-feature handoff
apps/desktop/src/
├── images/
│   ├── logo-dark.svg                 # AZCO wordmark (blue)
│   └── logo-white.svg                # AZCO wordmark (white)
├── scss/list.scss                    # user-select/drag fix for cipher rows
├── index.html                        # <title>AZCO Vault</title>
├── main.ts                           # tray tooltip + credential key label
├── main/menu/menu.about.ts           # rebranded About dialog
├── main/menu/menu.bitwarden.ts       # rebranded first-menu label
├── main/window.main.ts               # force-enabled DevTools
├── package.json                      # @azco/azco-vault + productName
├── locales/en/messages.json          # "bitwarden" key → "AZCO Vault"
└── vault/app/
    ├── vault/
    │   ├── assign-collections/       # existing — used by us via dialog
    │   ├── item-footer.component.*   # Share-as-link button + handler
    │   ├── vault-items-v2.component.*# drag source + legacy + menu wiring
    │   └── ...
    └── vault-v3/
        ├── vault.component.*         # v3 layout wiring
        ├── vault-orig.component.*    # legacy layout wiring
        ├── vault-list.component.*    # v3 list
        └── vault-filter/
            ├── vault-filter.component.*
            ├── collection-admin-dialog/
            │   ├── collection-admin-dialog.component.html
            │   └── collection-admin-dialog.component.ts
            └── filters/
                ├── collection-filter.component.*  # drop target + recursion + pencil
                └── organization-filter.component.*# per-org nav-group
libs/
├── assets/src/svg/svgs/
│   ├── bitwarden-logo.icon.ts        # replaced with AZCO wordmark (anon layout)
│   └── password-manager.ts           # replaced with AZCO wordmark (sidebar)
├── components/src/navigation/
│   ├── nav-logo.component.html       # tightened padding for wide wordmark
│   └── side-nav.service.ts           # DEFAULT_OPEN_WIDTH = MAX
└── common/src/auth/password-prelogin/
    └── password-prelogin-api.service.ts   # VW-compat endpoint reroute
```
