# AZCO Vault — fork notes

This repository is a **private fork of `bitwarden/clients`** (`origin` →
`AZCO-Corp/AZCO-Vault`, `upstream` → `bitwarden/clients`) that adds a
1Password-style timed share-link feature to the Bitwarden desktop app
and a small companion service that renders the shared item to the
recipient.

The upstream README is preserved unchanged at `README.md`. This file
describes only what AZCO changes and how to work with the fork.

## What the fork adds

### 1. Desktop: "Share as timed link" button

`apps/desktop/src/vault/app/vault/item-footer.component.*`

A new button sits next to **Edit** on the item view. Clicking it opens
a small dialog where you pick:

- Expiration — 1 hour / 1 day / 7 days / 14 days / 30 days (default 7 days)
- Audience — "Anyone with the link" (default) or "Only specific people…"
  which lets you paste a comma- or newline-separated email list.
  **Email restriction is UI-only for now**; true email-gated access is
  the v3 follow-up (see _Roadmap_).
- "Can only be viewed one time" toggle (off by default)

Under the hood:

1. The cipher is serialised to a plaintext body using a cipher-type
   switch — logins get name/url/username/password/TOTP, cards get
   cardholder/brand/number/expiry/CVV, identities get full name and
   address block, SSH keys get public/private/fingerprint, secure notes
   fall through to just name + notes. Empty fields are suppressed.
2. The body is wrapped in a `SendView` and saved through the existing
   `sendService.encrypt` → `sendApiService.save` pipeline — the same
   two-step save that the stock "new Send" form uses.
3. The access URL is rewritten from the default Vaultwarden origin
   (`vw.securusconverting.com`) to `share.azcocorp.com/#/<id>/<key>`
   so recipients only ever see the AZCO domain.
4. The URL is copied to the clipboard; a toast confirms the expiry
   and view-once state.

The desktop identity is rebranded to "AZCO Vault" (package name
`@azco/azco-vault`, Electron productName `AZCO Vault`), so the fork
runs as a fully independent Electron app with its own
`%APPDATA%\AZCO Vault\` data dir. It coexists with the stock
Bitwarden desktop app on the same machine.

### 2. `azco-share-viewer/` — the recipient-facing service

A minimal `nginx:alpine` container that serves a single-page viewer and
reverse-proxies the `POST /api/sends/access/<id>` call to the real
Vaultwarden. See `azco-share-viewer/README.md` for the deployment
runbook; the short version is: the viewer is built, published, and run
on **azco26** behind a Cloudflare tunnel that maps
`share.azcocorp.com → 127.0.0.1:8329`. Vaultwarden itself can stay
firewalled to the internal network since recipients never talk to it
directly.

### 3. Small compatibility + fork-convenience patches

- `libs/common/src/auth/password-prelogin/password-prelogin-api.service.ts`
  — routes `POST /identity/accounts/prelogin/password` (added in
  upstream 2026.4, not implemented by Vaultwarden 1.35.2) back to the
  classic `POST /api/accounts/prelogin`. Request and response shapes
  are identical. Fork-local; do not upstream.
- `apps/desktop/src/main/window.main.ts` — force-enable DevTools
  unconditionally so `Ctrl+Shift+I` works in the production Electron
  build (Bitwarden's custom menu doesn't bind `toggleDevTools`).
- `apps/desktop/src/images/logo-dark.svg` + `logo-white.svg` and
  `libs/assets/src/svg/svgs/password-manager.ts`,
  `libs/assets/src/svg/svgs/bitwarden-logo.icon.ts` — replace the
  Bitwarden wordmark with the AZCO wordmark (colour inherits from the
  existing theme classes, so light/dark sidebars still work).

## Working with the fork

### Build prerequisites (Windows + WSL)

- Node 22 (via fnm), `npm`
- Visual Studio Build Tools 2022 with the "Desktop development with
  C++" workload — needed for `node-gyp` native modules (`keytar`,
  `argon2`, `desktop_napi`)
- Rust toolchain 1.94.1 (pinned by
  `apps/desktop/desktop_native/rust-toolchain.toml`)
- Python 3, git, git-lfs

Desktop build must run on Windows itself (not WSL) because Electron
and the `desktop_napi` crate target the host OS. Helper scripts live
in `/root/scripts/bw-*.ps1` on the ASMB-LT01 dev machine.

### Typical iteration loop

```powershell
cd C:\AZCO-BitWarden\apps\desktop

# Full rebuild (main + renderer + preload + Rust)
npm run build-native
npm run build

# Run the app against the already-built artifacts (one-shot; the old
# `npm run electron` is a watcher and tends to restart on every change)
npm start
```

From WSL the helper scripts wrap this:

```bash
powershell.exe -ExecutionPolicy Bypass -File /root/scripts/bw-rebuild-all.ps1
powershell.exe -ExecutionPolicy Bypass -File /root/scripts/bw-launch.ps1
```

### Staying current with upstream

Every AZCO change lives on the `azco/rebrand` branch as discrete
commits, so rebasing onto a new upstream release is the usual dance:

```
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout azco/rebrand
git rebase main
# resolve any conflicts, rebuild, test, then force-push:
git push --force-with-lease origin azco/rebrand
```

Be careful with the Vaultwarden-compat prelogin patch — if upstream
Bitwarden reverts or reshuffles that endpoint, reapply by hand.

## Security model

**Desktop app.** No change from upstream's threat model. The share
feature only uses public `SendView` / `SendApiService` APIs and runs
through the same master-password reprompt as the delete / clone flows,
so a locked vault cannot be silently exfiltrated.

**Share viewer.** See `azco-share-viewer/README.md` for the full
deployment threat model. Highlights:

- The decryption key lives only in the URL fragment (`#…`). Browsers
  never send fragments to any server, so the key does not reach the
  viewer's backend, the Cloudflare tunnel, or Vaultwarden. All
  decryption happens in the recipient's browser with Web Crypto.
- The viewer reverse-proxies exactly one endpoint
  (`POST /api/sends/access/{id}`) to Vaultwarden; everything else is
  either a static asset or a 404.
- HMAC-SHA-256 is verified over `iv || ciphertext` before any
  AES-256-CBC decryption, matching Bitwarden's EncString format 2.
- Password and CVV are masked with a Show/Hide toggle, and TOTP is
  rendered as a rolling 6-digit code — the raw secret is never
  displayed.
- Rate limit: 10 requests/minute per client IP on the Send-access
  proxy, with a burst of 20.

## Roadmap

- **v3 — email-gated shares.** `share.azcocorp.com` becomes a thin
  AZCO-hosted identity gate: recipient enters their email, the viewer
  checks the allow-list stored with the Send, issues a short-lived
  2FA code via Graph/Exchange, and only reveals the Send URL after
  the code matches. No Vaultwarden changes needed — the v3 logic
  lives entirely in a new middleware layer in front of the existing
  Send access proxy.
- Firewall `vw.securusconverting.com` to accept requests only from
  the viewer's egress IP plus the internal LAN. Safe to do once v2
  is stable; the viewer is the only internet-facing client path.
- File-type shares in the viewer (currently only text Sends are
  rendered; files fall through to an "unsupported" error).
- Configurable share base URL — hard-coded to
  `https://share.azcocorp.com` right now.
