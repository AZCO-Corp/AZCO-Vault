import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { toObservable } from "@angular/core/rxjs-interop";
import {
  combineLatest,
  distinctUntilChanged,
  map,
  tap,
  Observable,
  startWith,
  pairwise,
} from "rxjs";

import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { FieldType } from "@bitwarden/common/vault/enums";
import { buildCipherIcon, CipherIconDetails } from "@bitwarden/common/vault/icon/build-cipher-icon";
import { CipherViewLike } from "@bitwarden/common/vault/utils/cipher-view-like-utils";

// AZCO: hidden custom-field name used to override the favicon on a per-item
// basis. Must match AZCO_ICON_FIELD_NAME in
// apps/desktop/src/vault/app/vault/azco-custom-icon.service.ts
const AZCO_ICON_FIELD_NAME = "__azco_icon";
const AZCO_ICON_DATA_URL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

@Component({
  selector: "app-vault-icon",
  templateUrl: "icon.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class IconComponent {
  /**
   * The cipher to display the icon for.
   */
  readonly cipher = input.required<CipherViewLike>();

  /**
   * coloredIcon will adjust the size of favicons and the colors of the text icon when user is in the item details view.
   */
  readonly coloredIcon = input<boolean>(false);

  /**
   * Optional custom size for the icon in pixels.
   * When provided, forces explicit dimensions on the icon wrapper to prevent layout collapse at different zoom levels.
   * If not provided, the wrapper has no explicit dimensions and relies on CSS classes (tw-size-6/24px for images).
   * This can cause the wrapper to collapse when images are loading/hidden, especially at high browser zoom levels.
   * Reference: default image size is tw-size-6 (24px), coloredIcon uses 36px.
   */
  readonly size = input<number>();

  readonly imageLoaded = signal(false);

  // AZCO: when a cipher carries an `__azco_icon` hidden custom field, render
  // that data URL in place of the favicon. No-op for ciphers without the
  // field, so this is safe across web/browser/desktop.
  protected readonly customIcon = computed<string | null>(() => {
    const c = this.cipher() as unknown as {
      fields?: Array<{ name?: string; value?: string; type?: number }>;
    };
    const fields = c?.fields;
    if (!fields || fields.length === 0) {
      return null;
    }
    const f = fields.find((x) => x?.name === AZCO_ICON_FIELD_NAME && x?.type === FieldType.Hidden);
    if (!f?.value || !AZCO_ICON_DATA_URL_RE.test(f.value)) {
      return null;
    }
    return f.value;
  });

  /**
   * Computed style object for icon dimensions.
   * Centralizes the sizing logic to avoid repetition in the template.
   */
  protected readonly iconStyle = computed(() => {
    if (this.coloredIcon()) {
      return { width: "36px", height: "36px" };
    }
    const size = this.size();
    if (size) {
      return { width: size + "px", height: size + "px" };
    }
    return {};
  });

  protected readonly data$: Observable<CipherIconDetails>;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly domainSettingsService: DomainSettingsService,
  ) {
    const iconSettings$ = combineLatest([
      this.environmentService.environment$.pipe(map((e) => e.getIconsUrl())),
      this.domainSettingsService.showFavicons$.pipe(distinctUntilChanged()),
    ]).pipe(
      map(([iconsUrl, showFavicon]) => ({ iconsUrl, showFavicon })),
      startWith({ iconsUrl: null, showFavicon: false }), // Start with a safe default to avoid flickering icons
      distinctUntilChanged(),
    );

    this.data$ = combineLatest([iconSettings$, toObservable(this.cipher)]).pipe(
      map(([{ iconsUrl, showFavicon }, cipher]) => buildCipherIcon(iconsUrl, cipher, showFavicon)),
      startWith(null),
      pairwise(),
      tap(([prev, next]) => {
        if (prev?.image !== next?.image) {
          // The image changed, reset the loaded state to not show an empty icon
          this.imageLoaded.set(false);
        }
      }),
      map(([_, next]) => next!),
    );
  }
}
