# azco-share-viewer

A single-page browser viewer that renders a Bitwarden Send link shared
by the AZCO Vault desktop fork. Runs as a small `nginx:alpine`
container on `azco26` and is fronted by the Cloudflare tunnel
`share.azcocorp.com`.

## What it is

- One static HTML page (`public/index.html`), one stylesheet
  (`public/styles.css`), one ES module (`public/app.js`), one SVG
  logo (`public/logo-blue.svg`).
- An `nginx.conf` that serves those assets and reverse-proxies
  exactly one endpoint — `POST /api/sends/access/{id}` — to the real
  Vaultwarden at `vw.securusconverting.com`. Everything else returns 404.
- No application code, no database, no state, no session. The
  decryption key lives in the URL fragment (`#/<accessId>/<urlB64Key>`)
  and never leaves the recipient's browser.

## Architecture

```
recipient browser ── HTTPS ──▶ Cloudflare tunnel ──▶ 127.0.0.1:8329 on azco26
                                                      │
                                                      │  serves /, /index.html,
                                                      │  /app.js, /styles.css,
                                                      │  /logo-blue.svg, /healthz
                                                      │
                                                      └── proxy_pass ──▶ vw.securusconverting.com
                                                          POST /api/sends/access/{id}
```

The browser POSTs the encrypted Send to the proxy, gets the EncString
payload back, runs HKDF-SHA256(key, salt="bitwarden-send", info="send")
over the URL key to derive encKey + macKey, verifies HMAC-SHA-256 over
`iv || ciphertext`, and AES-256-CBC decrypts the body. That matches
`libs/key-management/src/key.service.ts :: makeSendKey` and
`libs/common/.../default-key-generation.service.ts :: deriveKeyFromMaterial`
in the upstream Bitwarden client, so we stay bit-compatible with
whatever the desktop fork produces.

## Build & run (on azco26)

```bash
# First time (repo layout assumes /home/AZCO-Vault tracks origin/azco/rebrand)
cd /home/AZCO-Vault
git fetch origin
git checkout azco/rebrand
git pull --ff-only

cd /home/AZCO-Vault/azco-share-viewer
docker build -t azco-share-viewer:latest .
docker rm -f azco-share-viewer 2>/dev/null
docker run -d \
  --name azco-share-viewer \
  --restart unless-stopped \
  -p 127.0.0.1:8329:8080 \
  azco-share-viewer:latest

# Smoke test
curl -sS http://127.0.0.1:8329/healthz           # → ok
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST -H "Content-Type: application/json" \
  -d '{"password":null}' \
  http://127.0.0.1:8329/api/sends/access/deadbeef  # → 404 from Vaultwarden
```

### Updating the live container

After pushing a commit to `origin/azco/rebrand`:

```bash
ssh root@azco26
cd /home/AZCO-Vault && git pull --ff-only
cd azco-share-viewer
docker build -t azco-share-viewer:latest .
docker rm -f azco-share-viewer
docker run -d --name azco-share-viewer --restart unless-stopped \
  -p 127.0.0.1:8329:8080 azco-share-viewer:latest
```

Because Cloudflare edge-caches static assets aggressively, bump the
`?v=…` query on `/app.js`, `/styles.css`, and `/logo-blue.svg` inside
`public/index.html` any time those files change — otherwise recipients
will keep loading the cached versions for up to four hours. The
`index.html` response itself ships `Cache-Control: no-store, must-revalidate`
so HTML changes propagate on the next page load.

## Security model

### What the viewer backend sees

- Static file requests (public)
- POST bodies to `/api/sends/access/{id}` which are forwarded verbatim
  to Vaultwarden
- Encrypted Send payloads flowing back from Vaultwarden

### What it never sees

- The Send decryption key (URL fragment — browser side only)
- The plaintext cipher (decrypted in the recipient's browser)
- The recipient's master password (doesn't exist — Send is a capability,
  not an authenticated flow)

### Hardening in place

- `server_tokens off`
- Strict CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer` (so fragments can't leak via referer)
- `Strict-Transport-Security: max-age=31536000`
- `Permissions-Policy`: geolocation, microphone, camera all `()`
- Explicit allow-list of static files — anything else returns 404
- HTTP method allow-list on the proxy (POST / OPTIONS only)
- Rate limit: 10 req/min per client IP on `/api/sends/access/*`,
  burst 20 (zone `send_access`, 10 MB of state)
- `proxy_ssl_verify on` against the container's CA bundle
- Cookies from Vaultwarden hidden from recipient responses
- Listens only on `127.0.0.1:8329` — the Cloudflare tunnel is the
  only way to reach it

### Known gaps

- Vaultwarden itself is still reachable at `vw.securusconverting.com`
  through the CF tunnel. Once v2 is stable, firewall VW to accept
  traffic only from the viewer egress + internal LAN.
- No logging redaction on client IPs. nginx's access log retains
  whatever logrotate is configured to keep.
- No fail2ban — a sustained 404 sprayer will eventually get
  throttled by the rate limit but not permanently blocked.

## Error handling reference

`app.js` surfaces the following explicit states to the user, each
with a distinct message in the `#error` card:

| Condition                                    | Message                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| URL fragment missing or malformed            | "This link is incomplete…"                                         |
| Vaultwarden returns 404 / 410                | "This share has expired, been revoked, or reached its view limit." |
| Vaultwarden returns 401 (password-protected) | "This share requires a password…" (not yet supported)              |
| Fetch network failure                        | "Could not reach the share service…"                               |
| Content is a file Send (not text)            | "…this viewer does not yet support files."                         |
| HMAC verify fails or AES-CBC decrypt throws  | "Decryption failed. The link may be tampered…"                     |

TOTP-specific: if the detected secret can't be parsed (invalid base32
or malformed otpauth URL), the row gracefully falls back to a masked
regular row so the user still sees the raw value with Copy/Show.

## File map

```
azco-share-viewer/
├── Dockerfile          # nginx:1.27-alpine base, copies config + public/
├── nginx.conf          # server block, hardening, rate limit, proxy
├── README.md           # this file
└── public/
    ├── app.js          # Send decryption + TOTP + UI
    ├── index.html      # single-page shell
    ├── logo-blue.svg   # AZCO wordmark
    └── styles.css      # layout + AZCO brand palette
```
