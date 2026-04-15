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
function parseShareBody(text) {
  const fields = [];
  let notes = "";
  const lines = text.split("\n");
  let i = 0;
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
  return { fields, notes };
}

// ─── UI rendering ──────────────────────────────────────────────────
const SENSITIVE_LABELS = new Set(["Password", "CVV", "SSN", "Private Key", "Number"]);

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
  const inner = document.createElement("span");
  inner.textContent = value;
  val.appendChild(inner);

  const sensitive = SENSITIVE_LABELS.has(label);
  if (sensitive) val.classList.add("masked");

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
      const original = copy.textContent;
      copy.textContent = "Copied";
      copy.classList.add("copied");
      setTimeout(() => {
        copy.textContent = original;
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

function renderContent({ fields, notes, expirationDate }) {
  const container = document.getElementById("fields");
  container.replaceChildren();
  for (const f of fields) {
    if (f.value === undefined || f.value === null || f.value === "") continue;
    container.appendChild(makeRow(f.label, f.value));
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
    const { fields, notes } = parseShareBody(plaintext);
    renderContent({
      fields,
      notes,
      expirationDate: sendResp.expirationDate ?? sendResp.deletionDate,
    });
  } catch (e) {
    showError("Decryption failed. The link may be tampered or this client is incompatible.");
  }
}

void main();
