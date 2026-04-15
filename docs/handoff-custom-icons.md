# Handoff — custom icons on vault items

**Read `AZCO.md` at the repo root first** for project context. Branch:
`azco/rebrand`. Build/launch helpers are in `/root/scripts/bw-*.ps1`.

## What you're building

Give users the ability to override the default favicon on any vault
item with a custom image. Clicking the icon itself acts as the
"change icon" affordance — no new button. Right-clicking offers
"Remove icon" to revert to favicon behaviour. The chosen icon also
rides along in share links so recipients see it in the share viewer.

The user signed off on this scope. Implement and ship; don't re-
plan the UX unless you hit something infeasible.

## Data model — no Vaultwarden changes needed

Custom icons are stored as a **hidden custom field** on the cipher
with the magic name `__azco_icon`. The value is a data URL, e.g.
`data:image/jpeg;base64,/9j/4AAQ…`. Bitwarden encrypts and syncs
custom fields automatically — Vaultwarden needs no modifications.

Limits enforced client-side:

| Rule                        | Value             |
| --------------------------- | ----------------- |
| Max input file size         | 2 MB              |
| Resize to                   | 256 × 256 max     |
| Output format               | JPEG quality 0.7  |
| Expected final payload size | < 40 KB           |
| Accept                      | `image/*`         |
| Custom field type           | `Hidden` (enum 1) |
| Custom field name           | `__azco_icon`     |

Use a `<canvas>` + `CanvasRenderingContext2D.drawImage` + `canvas.toDataURL("image/jpeg", 0.7)` pipeline. Reject inputs whose resulting data URL doesn't start with `data:image/`.

## Files to touch

### 1. A small helper service (new)

`apps/desktop/src/vault/app/vault/azco-custom-icon.service.ts`

Expose two pure functions. Keep it a plain `@Injectable()` so it
can be provided at `root`:

```ts
readCustomIcon(cipher: CipherView): string | null
writeCustomIcon(cipher: CipherView, dataUrl: string | null): void
```

`readCustomIcon` scans `cipher.fields` for an entry named
`__azco_icon` (case-sensitive) of type `FieldType.Hidden` and returns
the value if it's a valid `data:image/*;base64,` URL, otherwise
`null`. `writeCustomIcon` mutates `cipher.fields` in place — if
`dataUrl` is null, remove the field; otherwise upsert it. The caller
is responsible for persisting via `cipherService.encrypt` +
`cipherService.saveWithServer` / `updateWithServer`.

Put the constant in the same file:

```ts
export const AZCO_ICON_FIELD_NAME = "__azco_icon";
```

Also add a resize utility:

```ts
async resizeImageToDataUrl(
  file: File,
  maxSize = 256,
  quality = 0.7,
): Promise<string>
```

Uses an off-screen `Image` + `canvas`. Throws on non-image MIME or
decode failure. Callers show a toast and bail on throw.

### 2. `app-vault-icon` — read path

`libs/vault/src/components/vault-icon/vault-icon.component.ts` (or
wherever `<app-vault-icon>` is defined — verify; there may be a
desktop-specific override at
`apps/desktop/src/vault/...` too). Prefer the desktop override if it
exists so the change stays off the shared component. If you must
edit the shared one, gate it behind `AzcoCustomIconService.read` so
it's a no-op for non-AZCO ciphers (missing field → current
behaviour).

Pseudocode:

```ts
protected readonly customIcon = computed<string | null>(() => {
  const c = this.cipher();
  if (!c) return null;
  return this.customIconService.readCustomIcon(c);
});
```

Template — render `customIcon()` as an `<img>` if present, otherwise
fall through to the existing favicon rendering. Size should match
the existing icon dimensions so no layout shift.

### 3. Click-to-upload on the item view (desktop)

Prefer to live in the existing cipher view component. Identify the
element that renders the icon on the desktop item view (probably
inside `cipher-view.component.html` in `libs/vault/` or the desktop's
v3 / legacy vault view), wrap it in a clickable surface, and attach
an `(click)` handler that:

1. Guards on "user has write access to this cipher"
   (`cipher.edit === true`).
2. Programmatically opens a hidden `<input type="file" accept="image/*">`.
3. On file select, runs the resize helper, shows a toast on error,
   sets the custom field via `writeCustomIcon`, and saves the cipher.
4. Shows a success toast.

Because the user is on the legacy vault layout
(`vault-orig.component` + `vault-items-v2.component`), make sure the
click affordance works in that path. Likely place: the `app-vault-icon`
rendered inside the item list row AND in the open item view. Scope the
click handler to the item view only (clicking rows in the list
already navigates — don't hijack it).

### 4. Right-click "Remove icon"

Add a native context menu entry by extending the existing
`rightClickCipher` flow in `vault-items-v2.component.ts`, OR simpler:
add a small "×" button that appears on hover over the icon in the
item view when a custom icon is set. Your call — pick whichever is
less invasive.

### 5. Share body builder — include the icon

`apps/desktop/src/vault/app/vault/item-footer.component.ts` —
`buildShareBody(c: CipherView)` / the inline body builder.

If `readCustomIcon(c)` returns a value, prepend a line to the body:

```
Icon: data:image/jpeg;base64,<...>
```

Don't add it to the regular `rows` array — it should not render as a
field in the recipient viewer's table, only as a header icon. Keep
the existing body format (`Label: value\n…\nNotes:\n…`) working.

### 6. Share viewer — parse and render the icon

`azco-share-viewer/public/app.js`

In `parseShareBody`, detect a line starting with `Icon:` before any
other field and stash its value in the returned object:

```js
function parseShareBody(text) {
  // ... existing parsing, plus:
  // Pull out an Icon: <data url> header line if it's the first line
}
```

Return shape: `{ icon: string | null, fields, notes }`.

In `renderContent`, if `icon` is present, create an `<img>` element
and put it as the first child of the content card, styled as a
round 72×72 thumbnail with a subtle border. Fall back gracefully to
no icon when absent (current behaviour).

`public/styles.css` needs one small rule:

```css
.card .share-icon {
  display: block;
  width: 72px;
  height: 72px;
  border-radius: 16px;
  object-fit: cover;
  border: 1px solid var(--border);
  margin: 0 auto 16px;
  background: var(--card-bg);
}
```

Rev the `?v=` query on the asset links in `index.html` (currently
`?v=3`, bump to `?v=4`) so Cloudflare edge picks up the new JS/CSS.
Rebuild the image on `azco26` via
`/home/AZCO-Vault/azco-share-viewer` — the runbook is in
`azco-share-viewer/README.md`.

## Acceptance criteria

- [ ] Open a login item, click its icon → native file picker opens
- [ ] Pick a PNG/JPEG/WebP → toast "Icon updated", item icon changes
- [ ] Close and reopen the app → custom icon persists
- [ ] Right-click / hover × → "Remove icon" reverts to favicon
- [ ] Item list rows in the sidebar show the custom icon too
- [ ] Share the item as a link → recipient sees the custom icon at the
      top of the share viewer card
- [ ] Share an item without a custom icon → viewer renders as today
      (no broken img)
- [ ] An oversized (5 MB) file gets rejected with a toast
- [ ] A non-image file (e.g. PDF) gets rejected with a toast
- [ ] Non-admin / read-only cipher: click does nothing (or shows
      "You don't have permission")
- [ ] Sync pulls the icon when logging in on a second device — custom
      fields flow through VW normally

## Implementation tips

- **Find the right `app-vault-icon`**. There are at least two renders
  — the item list row and the cipher-view header. Both need to honour
  the custom icon. The shared component lives in `libs/vault/src/`.
  Grep for `<app-vault-icon` to find every usage.
- **Don't forget the cipher is read-encrypted**. You mutate the
  `CipherView`, not the `Cipher` domain. Then call
  `cipherService.encrypt(cipherView, userId)` → the encryptor
  re-encrypts the hidden field for you.
- **Custom field type matters**. `FieldType.Hidden` (enum value `1`)
  is what you want; `FieldType.Text` (`0`) would display in the item
  view and pollute the UI.
- **The fullSync hammer works** for triggering the sidebar to
  re-render. Use `this.syncService.fullSync(true)` after save if you
  see stale icons in the list.
- **No Vaultwarden changes**. Every byte of this feature is client-
  side plus the existing Send body channel. Don't touch the VW
  compose file.
- **Test with legacy layout**, since that's what Vaultwarden serves
  by default. Confirm by checking `DesktopUiMigrationMilestone3`
  feature flag evaluates to false via `configService.getFeatureFlag$`.

## Out of scope for this round

- Icon library / default AZCO-branded icons
- SVG upload (too easy to abuse, keep it to bitmap)
- Icon per collection (only per-cipher)
- Icon propagation during "Share to Organization" re-encryption
- Backfilling icons from the favicon cache

## Commit style

One commit, message format:

```
azco: custom icons on vault items (+ share viewer support)

<body>

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to `origin/azco/rebrand` when tests pass (build exit 0 +
manual acceptance criteria walkthrough).

## Contact / ownership

Sal (`sromano@azcocorp.com`) is the PO for this feature. The existing
AZCO Vault conversation includes full UX decisions on scope — most
relevant:

- **"Click the icon. that's the button."** — no separate "Change
  icon" UI element.
- **"Remove icon reverts to favicon."** — removing the hidden field
  is the revert.
- **"Icon carries through to the shared item link."** — the share
  viewer renders it at the top of the card, not as a table row.
