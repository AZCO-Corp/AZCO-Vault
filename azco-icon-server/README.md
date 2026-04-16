# azco-icon-server

Serves per-cipher custom icons as favicons so official Bitwarden clients
(iOS, Android, web, desktop) render them without any client-side patches.

## How it works

Each custom icon is stored as `{hash}.jpg` where hash is the first 12 hex
chars of SHA-256 over the JPEG content. AZCO Vault adds a secondary URI
`https://{hash}.ico.securusconverting.com` to the cipher. When any BW client
resolves the favicon for that domain, the request hits this server (via
wildcard DNS + Cloudflare tunnel), which serves the stored image.

## Deployment (azco26)

```bash
# Generate a token
export AZCO_ICON_TOKEN=$(openssl rand -hex 32)
echo "AZCO_ICON_TOKEN=$AZCO_ICON_TOKEN" > .env

# Build and start
docker compose up -d --build

# Verify
curl http://127.0.0.1:8330/healthz
```

Runs on `127.0.0.1:8330`. Front it with a Cloudflare tunnel:

- Tunnel hostname: `*.ico.securusconverting.com` → `http://127.0.0.1:8330`
- Also add: `ico.securusconverting.com` → `http://127.0.0.1:8330` (for the upload API)

## Cloudflare DNS

- `ico.securusconverting.com` — CNAME to your tunnel (proxied)
- `*.ico.securusconverting.com` — CNAME to your tunnel (proxied)

## API

### Upload icon

```
POST https://ico.securusconverting.com/api/store/{hash}
Authorization: Bearer <AZCO_ICON_TOKEN>
Content-Type: application/octet-stream
Body: <raw JPEG bytes>
```

### Delete icon

```
DELETE https://ico.securusconverting.com/api/store/{hash}
Authorization: Bearer <AZCO_ICON_TOKEN>
```

### Serve favicon (automatic, via subdomain)

```
GET https://{hash}.ico.securusconverting.com/favicon.ico → stored JPEG
GET https://{hash}.ico.securusconverting.com/            → HTML with <link rel="icon">
```

## Icon storage

Icons are stored in a Docker volume (`icon-data`) mounted at `/data/icons/`.
Typical icon size is 30-40 KB (256×256 JPEG q0.7). At 10,000 icons that's
~400 MB — trivial.

Same image content → same hash → one file. Deduplication is automatic.
