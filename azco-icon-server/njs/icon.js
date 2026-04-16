// AZCO Icon Server — njs handlers for favicon serving and icon management.
//
// Icons are stored on disk at /data/icons/{hash}.jpg where {hash} is the
// first 12 hex chars of SHA-256 over the image content. The hash arrives
// via the Host header: {hash}.ico.azcocorp.com.

var fs = require("fs");

var ICON_DIR = "/data/icons";
// Match {hash}.ico.{anything} — domain-agnostic so the same image
// works with any ico.* deployment without rebuilding the container.
var HASH_RE = /^([a-f0-9]{12})\.ico\./;
var STORE_RE = /^\/api\/store\/([a-f0-9]{12})$/;

// 1×1 transparent PNG fallback so VW doesn't cache an error.
var FALLBACK_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
  "Nl7BcQAAAABJRU5ErkJggg==";

function extractHash(r) {
  var host = r.headersIn["Host"] || "";
  var m = HASH_RE.exec(host.toLowerCase());
  return m ? m[1] : null;
}

function iconPath(hash) {
  return ICON_DIR + "/" + hash + ".jpg";
}

function serveFavicon(r) {
  var hash = extractHash(r);
  if (!hash) {
    // No valid hash in subdomain — serve transparent fallback.
    r.headersOut["Content-Type"] = "image/png";
    r.headersOut["Cache-Control"] = "public, max-age=86400";
    r.return(200, Buffer.from(FALLBACK_B64, "base64"));
    return;
  }

  try {
    var data = fs.readFileSync(iconPath(hash));
    r.headersOut["Content-Type"] = "image/jpeg";
    r.headersOut["Cache-Control"] = "public, max-age=604800, immutable";
    r.return(200, data);
  } catch (e) {
    // Icon not found — serve transparent fallback.
    r.headersOut["Content-Type"] = "image/png";
    r.headersOut["Cache-Control"] = "public, max-age=300";
    r.return(200, Buffer.from(FALLBACK_B64, "base64"));
  }
}

function serveIndex(r) {
  var hash = extractHash(r);
  var icon = hash ? "/favicon.ico" : "";
  var html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    (icon ? '<link rel="icon" href="' + icon + '">' : "") +
    "<title>AZCO</title></head><body></body></html>";
  r.headersOut["Content-Type"] = "text/html; charset=utf-8";
  r.headersOut["Cache-Control"] = "public, max-age=86400";
  r.return(200, html);
}

function handleStore(r) {
  // Auth check
  var token = process.env.AZCO_ICON_TOKEN || "";
  if (!token) {
    r.return(500, '{"error":"server misconfigured: no token"}\n');
    return;
  }
  var auth = r.headersIn["Authorization"] || "";
  if (auth !== "Bearer " + token) {
    r.return(401, '{"error":"unauthorized"}\n');
    return;
  }

  var m = STORE_RE.exec(r.uri);
  if (!m) {
    r.return(400, '{"error":"invalid hash"}\n');
    return;
  }
  var hash = m[1];
  var path = iconPath(hash);

  if (r.method === "DELETE") {
    try {
      fs.unlinkSync(path);
    } catch (e) {
      // Already gone — that's fine.
    }
    r.return(200, '{"ok":true,"deleted":"' + hash + '"}\n');
    return;
  }

  // POST — store icon
  if (r.method === "POST") {
    var body = r.requestBuffer;
    if (!body || body.length === 0) {
      r.return(400, '{"error":"empty body"}\n');
      return;
    }
    if (body.length > 102400) {
      r.return(413, '{"error":"too large"}\n');
      return;
    }

    try {
      fs.writeFileSync(path, body, { mode: 0o644 });
    } catch (e) {
      r.return(500, '{"error":"write failed: ' + e.message + '"}\n');
      return;
    }
    r.return(201, '{"ok":true,"stored":"' + hash + '"}\n');
    return;
  }

  r.return(405, '{"error":"method not allowed"}\n');
}

export default { serveFavicon, serveIndex, handleStore };
