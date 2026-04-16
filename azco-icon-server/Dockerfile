FROM nginx:1.27-alpine

# nginx njs module for request handling logic.
RUN apk add --no-cache nginx-mod-http-js

COPY nginx.conf /etc/nginx/nginx.conf
COPY njs/ /etc/nginx/njs/

# Icon storage directory — mount a volume here for persistence.
RUN mkdir -p /data/icons

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
