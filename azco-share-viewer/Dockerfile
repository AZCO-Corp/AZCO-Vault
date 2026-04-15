FROM nginx:1.27-alpine

# Static assets and nginx config for the AZCO share viewer.
# This image does NOT contain any AZCO secrets or vault data.
# Its only backend job is reverse-proxying /api/sends/access/* to the
# upstream Vaultwarden. All crypto happens client-side in the browser;
# the decryption key never leaves the URL fragment.

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
