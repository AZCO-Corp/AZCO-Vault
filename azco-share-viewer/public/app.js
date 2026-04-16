// AZCO Share Viewer — client-side Bitwarden Send decryption.
//
// Mirrors bitwarden/clients:
//   - libs/key-management/src/key.service.ts :: makeSendKey
//   - libs/common/src/key-management/crypto/key-generation/default-key-generation.service.ts
//     :: deriveKeyFromMaterial (HKDF salt="bitwarden-send", info="send", 64 bytes)
//   - EncString format 2: "2.<b64 iv>|<b64 ct>|<b64 mac>"
//     AES-256-CBC + HMAC-SHA-256 over iv||ct, MAC verified before decrypt.
//
// The decryption key lives only in the URL fragment (#); browsers never
// send fragments to any server. This viewer's backend is a thin reverse
// proxy to Vaultwarden that sees only encrypted ciphertext passing through.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

// ─── base64 helpers ────────────────────────────────────────────────
function b64ToBytes(b64) {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ─── Bitwarden-compatible HKDF-SHA256 ──────────────────────────────
// Returns 64 bytes: first 32 = encKey, last 32 = macKey.
async function deriveSendKey(urlKeyBytes) {
  const ikm = await subtle.importKey("raw", urlKeyBytes, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: te.encode("bitwarden-send"),
      info: te.encode("send"),
    },
    ikm,
    64 * 8,
  );
  const full = new Uint8Array(bits);
  return { encKey: full.slice(0, 32), macKey: full.slice(32, 64) };
}

// ─── EncString type 2 decrypt ───────────────────────────────────────
async function decryptEncString(encString, encKey, macKey) {
  const match = /^2\.([^|]+)\|([^|]+)\|(.+)$/.exec(encString ?? "");
  if (!match) throw new Error("Unsupported EncString format");
  const iv = b64ToBytes(match[1]);
  const ct = b64ToBytes(match[2]);
  const mac = b64ToBytes(match[3]);

  const macKeyImp = await subtle.importKey(
    "raw",
    macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const macData = concatBytes(iv, ct);
  const valid = await subtle.verify("HMAC", macKeyImp, mac, macData);
  if (!valid) throw new Error("MAC verification failed");

  const encKeyImp = await subtle.importKey("raw", encKey, { name: "AES-CBC" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-CBC", iv }, encKeyImp, ct);
  return td.decode(pt);
}

// ─── parse shared body format produced by the desktop fork ─────────
// Lines like "Label: value" followed by a blank line and then "Notes:\n<text>".
// The desktop fork may prepend a single `Icon: data:image/...;base64,...`
// header line (custom item icon). We strip it from the field list and
// expose it on the parsed object so the renderer can show it above the card.
const ICON_DATA_URL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
function parseShareBody(text) {
  const fields = [];
  let notes = "";
  let icon = null;
  const lines = text.split("\n");
  let i = 0;

  // Optional Icon: <data url> header line. Must be the very first line.
  if (lines.length > 0 && lines[0].startsWith("Icon: ")) {
    const candidate = lines[0].slice("Icon: ".length).trim();
    if (ICON_DATA_URL_RE.test(candidate)) {
      icon = candidate;
    }
    i = 1;
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      i++;
      break;
    }
    const m = /^([A-Za-z ]+):\s?(.*)$/.exec(line);
    if (m) {
      fields.push({ label: m[1].trim(), value: m[2] });
    }
  }
  if (lines[i] === "Notes:") {
    notes = lines
      .slice(i + 1)
      .join("\n")
      .trimEnd();
  } else if (i < lines.length) {
    // No Notes marker — remainder is free text.
    notes = lines.slice(i).join("\n").trimEnd();
  }
  return { icon, fields, notes };
}

// ─── TOTP (RFC 6238) ───────────────────────────────────────────────
// The desktop app puts the TOTP secret (or the otpauth:// URL) into the
// share body. The recipient never needs to see the raw secret — we parse
// it client-side and render only the current rolling 6-digit code, which
// refreshes every 30 seconds. Copy always grabs the *current* code.

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 char");
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function parseTotpSpec(value) {
  if (!value || typeof value !== "string") return null;
  let secret = value;
  let period = 30;
  let digits = 6;
  if (/^otpauth:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      const p = u.searchParams;
      if (p.get("secret")) secret = p.get("secret");
      if (p.get("period")) period = parseInt(p.get("period"), 10) || 30;
      if (p.get("digits")) digits = parseInt(p.get("digits"), 10) || 6;
    } catch {
      return null;
    }
  }
  try {
    const bytes = base32Decode(secret);
    if (bytes.length === 0) return null;
    return { bytes, period, digits };
  } catch {
    return null;
  }
}

async function computeTotp(secretBytes, nowMs, period, digits) {
  const counter = Math.floor(nowMs / 1000 / period);
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false);
  const key = await subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await subtle.sign("HMAC", key, counterBytes));
  const offset = sig[sig.length - 1] & 0x0f;
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

function makeTotpRow(label, value) {
  const spec = parseTotpSpec(value);
  if (!spec) {
    // Couldn't parse — fall back to a normal masked row.
    return makeRow(label, value);
  }

  const row = document.createElement("div");
  row.className = "field totp-field";

  const lbl = document.createElement("span");
  lbl.className = "label";
  lbl.textContent = label;

  const val = document.createElement("span");
  val.className = "value totp-value";
  const code = document.createElement("span");
  code.className = "totp-code";
  code.textContent = "••• •••";
  const progress = document.createElement("span");
  progress.className = "totp-progress";
  const bar = document.createElement("span");
  progress.appendChild(bar);
  val.appendChild(code);
  val.appendChild(progress);

  const actions = document.createElement("span");
  actions.className = "actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy TOTP code");
  let currentCode = "";
  copy.addEventListener("click", async () => {
    if (!currentCode) return;
    try {
      await copyToClipboard(currentCode);
      copy.textContent = "Copied";
      copy.classList.add("copied");
      setTimeout(() => {
        copy.textContent = "Copy";
        copy.classList.remove("copied");
      }, 1400);
    } catch {
      /* clipboard denied — ignore */
    }
  });
  actions.appendChild(copy);

  row.appendChild(lbl);
  row.appendChild(val);
  row.appendChild(actions);

  const tick = async () => {
    try {
      const now = Date.now();
      currentCode = await computeTotp(spec.bytes, now, spec.period, spec.digits);
      code.textContent =
        spec.digits === 6 ? currentCode.replace(/(\d{3})(\d{3})/, "$1 $2") : currentCode;
      const sec = (now / 1000) % spec.period;
      const remaining = spec.period - sec;
      bar.style.width = ((remaining / spec.period) * 100).toFixed(1) + "%";
      progress.classList.toggle("low", remaining < 5);
    } catch {
      code.textContent = "error";
    }
  };
  void tick();
  setInterval(tick, 500);

  return row;
}

// ─── UI rendering ──────────────────────────────────────────────────
const SENSITIVE_LABELS = new Set(["Password", "CVV", "SSN", "Private Key", "Number"]);
const URL_LABELS = new Set(["URL"]);

function truncateMiddle(str, max) {
  if (str.length <= max) return str;
  const keep = Math.floor((max - 1) / 2);
  return str.slice(0, keep) + "…" + str.slice(-keep);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text);
}

function makeRow(label, value) {
  const row = document.createElement("div");
  row.className = "field";

  const lbl = document.createElement("span");
  lbl.className = "label";
  lbl.textContent = label;

  const val = document.createElement("span");
  val.className = "value";

  const sensitive = SENSITIVE_LABELS.has(label);
  const isUrl = URL_LABELS.has(label) && isHttpUrl(value);

  if (isUrl) {
    row.classList.add("url-field");
    const link = document.createElement("a");
    link.href = value;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "url-link";
    link.title = value;
    link.textContent = truncateMiddle(value, 70);
    val.appendChild(link);
  } else {
    const inner = document.createElement("span");
    inner.textContent = value;
    val.appendChild(inner);
    if (sensitive) val.classList.add("masked");
  }

  const actions = document.createElement("span");
  actions.className = "actions";

  if (sensitive) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = "Show";
    toggle.setAttribute("aria-label", `Show ${label}`);
    toggle.addEventListener("click", () => {
      const showing = val.classList.toggle("revealed");
      val.classList.toggle("masked", !showing);
      toggle.textContent = showing ? "Hide" : "Show";
      toggle.setAttribute("aria-label", `${showing ? "Hide" : "Show"} ${label}`);
    });
    actions.appendChild(toggle);
  }

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", `Copy ${label}`);
  copy.addEventListener("click", async () => {
    try {
      await copyToClipboard(value);
      copy.textContent = "Copied";
      copy.classList.add("copied");
      setTimeout(() => {
        copy.textContent = "Copy";
        copy.classList.remove("copied");
      }, 1400);
    } catch {
      /* clipboard denied — ignore */
    }
  });
  actions.appendChild(copy);

  row.appendChild(lbl);
  row.appendChild(val);
  row.appendChild(actions);
  return row;
}

function renderContent({ icon, fields, notes, expirationDate }) {
  // AZCO custom item icon: render as the first child of the content card,
  // ahead of the heading. Falls back to no icon when absent.
  const card = document.getElementById("content");
  const existingIcon = card.querySelector(".share-icon");
  if (existingIcon) {
    existingIcon.remove();
  }
  if (icon && ICON_DATA_URL_RE.test(icon)) {
    const img = document.createElement("img");
    img.className = "share-icon";
    img.src = icon;
    img.alt = "";
    img.decoding = "async";
    card.insertBefore(img, card.firstChild);
  }

  const container = document.getElementById("fields");
  container.replaceChildren();
  for (const f of fields) {
    if (f.value === undefined || f.value === null || f.value === "") continue;
    if (f.label === "TOTP") {
      container.appendChild(makeTotpRow(f.label, f.value));
    } else {
      container.appendChild(makeRow(f.label, f.value));
    }
  }
  if (notes) {
    const row = document.createElement("div");
    row.className = "notes-row";
    const lbl = document.createElement("span");
    lbl.className = "label";
    lbl.textContent = "Notes";
    const val = document.createElement("div");
    val.className = "value";
    val.textContent = notes;
    row.appendChild(lbl);
    row.appendChild(val);
    container.appendChild(row);
  }

  const expiry = document.getElementById("expiry");
  if (expirationDate) {
    const d = new Date(expirationDate);
    expiry.textContent = `Expires ${d.toLocaleString()}`;
  } else {
    expiry.textContent = "";
  }

  document.getElementById("loading").classList.add("hidden");
  document.getElementById("content").classList.remove("hidden");
}

function showError(message) {
  document.getElementById("loading").classList.add("hidden");
  document.getElementById("content").classList.add("hidden");
  const el = document.getElementById("error");
  el.classList.remove("hidden");
  document.getElementById("error-message").textContent = message;
}

// ─── bootstrap ─────────────────────────────────────────────────────
async function main() {
  // URL shape: /#/<accessId>/<urlB64Key>
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter((x) => x.length > 0);
  if (parts.length < 2) {
    showError("This link is incomplete. Make sure you copied the full URL.");
    return;
  }
  const [accessId, urlB64Key] = parts;

  let sendResp;
  try {
    const r = await fetch(`/api/sends/access/${encodeURIComponent(accessId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: null }),
    });
    if (r.status === 404 || r.status === 410) {
      showError("This share has expired, been revoked, or reached its view limit.");
      return;
    }
    if (r.status === 401) {
      showError(
        "This share requires a password. Password-protected shares are not yet supported in this viewer.",
      );
      return;
    }
    if (!r.ok) {
      showError(`Unexpected error (${r.status}) while fetching the share.`);
      return;
    }
    sendResp = await r.json();
  } catch (e) {
    showError("Could not reach the share service. Check your network and try again.");
    return;
  }

  if (sendResp?.type !== 0 /* SendType.Text */) {
    showError("This share contains a file, which this viewer does not yet support.");
    return;
  }

  try {
    const urlKeyBytes = b64ToBytes(urlB64Key);
    const { encKey, macKey } = await deriveSendKey(urlKeyBytes);
    const plaintext = await decryptEncString(sendResp.text?.text, encKey, macKey);
    const { icon, fields, notes } = parseShareBody(plaintext);
    renderContent({
      icon,
      fields,
      notes,
      expirationDate: sendResp.expirationDate ?? sendResp.deletionDate,
    });
  } catch (e) {
    showError("Decryption failed. The link may be tampered or this client is incompatible.");
  }
}

void main();
