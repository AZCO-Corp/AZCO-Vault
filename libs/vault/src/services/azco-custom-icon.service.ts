// AZCO: per-cipher custom icon helper.
//
// Stores a user-supplied image as a hidden custom field on the cipher
// (`__azco_icon`, FieldType.Hidden, value is a `data:image/jpeg;base64,...` URL).
// Bitwarden encrypts and syncs custom fields automatically, so no
// Vaultwarden-side changes are required. The image is read by
// app-vault-icon to override the default favicon, and by the share-link
// builder to ride along to the share viewer.
import { Injectable } from "@angular/core";

import { FieldType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FieldView } from "@bitwarden/common/vault/models/view/field.view";

export const AZCO_ICON_FIELD_NAME = "__azco_icon";

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
