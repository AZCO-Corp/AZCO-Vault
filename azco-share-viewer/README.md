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
  exactly one endpoint — `POST /api/sends/access/{id}` — to the
  upstream Vaultwarden container over Docker's internal network
  (never crosses the public internet). Everything else returns 404.
- No application code, no database, no state, no session. The
  decryption key lives in the URL fragment (`#/<accessId>/<urlB64Key>`)
  and never leaves the recipient's browser.

## Architecture

```
recipient browser ── HTTPS ──▶ Cloudflare tunnel ──▶ azco-share-viewer container
                                                      │   (listens on 127.0.0.1:8329)
                                                      │
                                                      │   serves /, /index.html,
                                                      │   /app.js, /styles.css,
                                                      │   /logo-blue.svg, /healthz
                                                      │
                                                      └── proxy_pass ──▶ vaultwarden container
                                                          POST /api/sends/access/{id}
                                                          via shared Docker network
                                                          (never leaves the host)
```

### Why container-to-container

The Send-access proxy targets the Vaultwarden container directly over
Docker's internal network instead of round-tripping through the public
Cloudflare-fronted Vaultwarden hostname. Three reasons:

- **Latency.** The hop is `share-viewer → vaultwarden:80` on the same
  Docker host instead of `share-viewer → CF edge → CF tunnel → host
nginx → vaultwarden`. Roughly 5× faster, and removes CF as a runtime
  dependency for share fetches.
- **Isolation.** The public Vaultwarden hostname can sit behind any
  auth layer (rate-limits, allow-lists, IdP gating, etc.). The share
  viewer's required endpoint — `POST /api/sends/access/*` — is
  intentionally anonymous; coupling it to a hostname that may later
  gain auth would silently break shares. Going direct guarantees the
  two policies stay independent.
- **Surface area.** Each share request used to leave the host and
  re-enter through the public edge. Now it stays inside Docker.

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
  --network <vaultwarden-docker-network> \
  -p 127.0.0.1:8329:8080 \
  azco-share-viewer:latest

# Smoke test
curl -sS http://127.0.0.1:8329/healthz           # → ok
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST -H "Content-Type: application/json" \
  -d '{"password":null}' \
  http://127.0.0.1:8329/api/sends/access/deadbeef  # → 404 from Vaultwarden
```

The `--network` value must match the Docker network your Vaultwarden
container is attached to (e.g. `vaultwarden_default` if VW was started
via `docker compose` from a directory named `vaultwarden/`). The
`nginx.conf` resolves the upstream as `http://vaultwarden:80` via
Docker's container-name DNS, so the Vaultwarden container must be
named `vaultwarden` on that network — or you can change the
`proxy_pass` target in `nginx.conf` to match your container name.

### Updating the live container

After pushing a commit to `origin/azco/rebrand`:

```bash
ssh root@azco26
cd /home/AZCO-Vault && git pull --ff-only
cd azco-share-viewer
docker build -t azco-share-viewer:latest .
docker rm -f azco-share-viewer
docker run -d --name azco-share-viewer --restart unless-stopped \
  --network <vaultwarden-docker-network> \
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
- Upstream proxy stays inside Docker's internal network — the
  Vaultwarden hostname is never resolved publicly and the request
  is never observable on the wire outside the host
- Cookies from Vaultwarden hidden from recipient responses
- Listens only on `127.0.0.1:8329` — the Cloudflare tunnel is the
  only way to reach it

### Known gaps

- No logging redaction on client IPs. nginx's access log retains
  whatever logrotate is configured to keep.
- No fail2ban — a sustained 404 sprayer will eventually get
  throttled by the rate limit but not permanently blocked.
- The proxy depends on Docker's container-name DNS for
  `vaultwarden:80`. If the upstream container is recreated and
  comes back with a different IP, the share viewer's resolver
  cache (60s TTL) re-resolves automatically; no restart needed.
  If the network or container name changes, the share viewer
  must be reconfigured.

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
