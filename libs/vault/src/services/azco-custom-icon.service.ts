// AZCO: per-cipher custom icon helper.
//
// Stores a user-supplied image as a hidden custom field on the cipher
// (`__azco_icon`, FieldType.Hidden, value is a `data:image/jpeg;base64,...` URL).
// Bitwarden encrypts and syncs custom fields automatically, so no
// Vaultwarden-side changes are required. The image is read by
// app-vault-icon to override the default favicon, and by the share-link
// builder to ride along to the share viewer.
import { Injectable } from "@angular/core";

import { CipherType, FieldType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FieldView } from "@bitwarden/common/vault/models/view/field.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";

export const AZCO_ICON_FIELD_NAME = "__azco_icon";

// ─── Icon server config ──────────────────────────────────────────
// Change these to point at a different icon server deployment.
// The wildcard DNS pattern is: {hash}.<AZCO_ICO_DOMAIN>
export const AZCO_ICO_CONFIG = {
  /** Base domain. Wildcard DNS routes {hash}.<domain> to the icon server. */
  domain: "ico.securusconverting.com",
  /** Upload/delete API base URL (bare domain, not a wildcard subdomain). */
  get apiBase() {
    return `https://${this.domain}/api/store`;
  },
  /** Bearer token sent with upload/delete requests. */
  token: "3634058708a9b25ef2ae7c86105e8e3557cb1234b874d841e69707a78725bdbb",
  /** Regex to match icon URIs on ciphers. Rebuilt from domain at module load. */
  get uriPattern() {
    const escaped = this.domain.replace(/\./g, "\\.");
    return new RegExp(`^https?://([a-f0-9]{12})\\.${escaped}/?$`, "i");
  },
};

const DATA_URL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

@Injectable({ providedIn: "root" })
export class AzcoCustomIconService {
  readCustomIcon(cipher: CipherView | null | undefined): string | null {
    if (!cipher?.fields) {
      return null;
    }
    const f = cipher.fields.find(
      (x) => x?.name === AZCO_ICON_FIELD_NAME && x?.type === FieldType.Hidden,
    );
    if (!f?.value || !DATA_URL_RE.test(f.value)) {
      return null;
    }
    return f.value;
  }

  writeCustomIcon(cipher: CipherView, dataUrl: string | null): void {
    if (!cipher.fields) {
      cipher.fields = [];
    }
    const idx = cipher.fields.findIndex(
      (x) => x?.name === AZCO_ICON_FIELD_NAME && x?.type === FieldType.Hidden,
    );

    if (dataUrl == null) {
      if (idx >= 0) {
        cipher.fields.splice(idx, 1);
      }
      return;
    }

    if (!DATA_URL_RE.test(dataUrl)) {
      throw new Error("Refusing to write non-image data URL as custom icon");
    }

    if (idx >= 0) {
      cipher.fields[idx].value = dataUrl;
      return;
    }

    const field = new FieldView();
    field.name = AZCO_ICON_FIELD_NAME;
    field.value = dataUrl;
    field.type = FieldType.Hidden;
    cipher.fields.push(field);
  }

  // ─── Icon server integration ─────────────────────────────────────
  // Uploads the icon to the icon server and inserts a `{hash}.ico.securusconverting.com`
  // URI on the cipher so official BW clients render it as a favicon.
  // Only applies to Login-type ciphers (other types don't have URIs).
  async syncIconToServer(cipher: CipherView, dataUrl: string): Promise<void> {
    const bytes = dataUrlToBytes(dataUrl);
    const hash = await hashIcon(bytes);

    // Upload to icon server
    const resp = await fetch(`${AZCO_ICO_CONFIG.apiBase}/${hash}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AZCO_ICO_CONFIG.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes.buffer as ArrayBuffer,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Icon server upload failed (${resp.status}): ${text}`);
    }

    // Add the icon URI as the first URI (only for logins).
    if (cipher.type === CipherType.Login) {
      this.upsertIconUri(cipher, hash);
    }
  }

  async removeIconFromServer(cipher: CipherView): Promise<void> {
    const existingHash = this.findIconUriHash(cipher);
    if (existingHash) {
      // Best-effort delete — don't fail the remove if the server is down.
      await fetch(`${AZCO_ICO_CONFIG.apiBase}/${existingHash}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${AZCO_ICO_CONFIG.token}` },
      }).catch(() => {});
    }
    this.removeIconUri(cipher);
  }

  // Find the existing ico.securusconverting.com URI hash on the cipher, if any.
  findIconUriHash(cipher: CipherView): string | null {
    if (cipher.type !== CipherType.Login || !cipher.login?.uris) {
      return null;
    }
    for (const u of cipher.login.uris) {
      const m = AZCO_ICO_CONFIG.uriPattern.exec(u.uri ?? "");
      if (m) {
        return m[1];
      }
    }
    return null;
  }

  private upsertIconUri(cipher: CipherView, hash: string): void {
    if (!cipher.login) {
      cipher.login = new LoginView();
    }
    if (!cipher.login.uris) {
      cipher.login.uris = [];
    }
    const iconUrl = `https://${hash}.${AZCO_ICO_CONFIG.domain}`;
    // Remove any existing icon URI.
    cipher.login.uris = cipher.login.uris.filter(
      (u) => !AZCO_ICO_CONFIG.uriPattern.test(u.uri ?? ""),
    );
    // Insert as first URI so BW resolves its favicon.
    const uriView = new LoginUriView();
    uriView.uri = iconUrl;
    cipher.login.uris.unshift(uriView);
  }

  private removeIconUri(cipher: CipherView): void {
    if (cipher.type !== CipherType.Login || !cipher.login?.uris) {
      return;
    }
    cipher.login.uris = cipher.login.uris.filter(
      (u) => !AZCO_ICO_CONFIG.uriPattern.test(u.uri ?? ""),
    );
  }

  // Resize an arbitrary user-supplied image to a square JPEG data URL.
  // Throws on non-image MIME or decode failure — callers show a toast.
  //
  // Uses a FileReader data-URL round-trip instead of URL.createObjectURL so
  // the intermediate image load honours the desktop CSP, which permits
  // `data:` but not `blob:` (see apps/desktop/src/index.html: `img-src 'self' data: *`).
  async resizeImageToDataUrl(file: File, maxSize = 256, quality = 0.7): Promise<string> {
    if (!file.type || !file.type.startsWith("image/")) {
      throw new Error("Selected file is not an image.");
    }

    const sourceDataUrl = await fileToDataUrl(file);
    const img = await loadImage(sourceDataUrl);
    const { width, height } = fitInside(img.naturalWidth, img.naturalHeight, maxSize);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context unavailable.");
    }
    // Fill white so transparent PNGs don't encode as black in JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (!dataUrl.startsWith("data:image/")) {
      throw new Error("Encoded image is not a valid data URL.");
    }
    return dataUrl;
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read image file."));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image."));
    img.src = src;
  });
}

function fitInside(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) {
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }
  const ratio = w >= h ? max / w : max / h;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  };
}

// Decode a data URL to raw bytes.
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid data URL");
  }
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

// SHA-256 hash of the image bytes → first 12 hex chars.
async function hashIcon(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (const b of arr) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex.slice(0, 12);
}
