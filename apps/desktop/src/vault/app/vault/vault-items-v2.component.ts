import { ScrollingModule } from "@angular/cdk/scrolling";
import { CommonModule } from "@angular/common";
import { Component, input, output } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { distinctUntilChanged, debounceTime } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { VaultItemsComponent as BaseVaultItemsComponent } from "@bitwarden/angular/vault/components/vault-items.component";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { uuidAsString } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { PremiumUpgradePromptService } from "@bitwarden/common/vault/abstractions/premium-upgrade-prompt.service";
import { SearchService } from "@bitwarden/common/vault/abstractions/search.service";
import { RestrictedItemTypesService } from "@bitwarden/common/vault/services/restricted-item-types.service";
import { SearchTextDebounceInterval } from "@bitwarden/common/vault/services/search.service";
import {
  CipherViewLike,
  CipherViewLikeUtils,
} from "@bitwarden/common/vault/utils/cipher-view-like-utils";
import { CalloutComponent, MenuModule } from "@bitwarden/components";

import { SearchBarService } from "../../../app/layout/search/search-bar.service";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-vault-items-v2",
  templateUrl: "vault-items-v2.component.html",
  imports: [MenuModule, CommonModule, JslibModule, ScrollingModule, CalloutComponent],
})
export class VaultItemsV2Component<C extends CipherViewLike> extends BaseVaultItemsComponent<C> {
  readonly showPremiumCallout = input<boolean>(false);

  readonly onAddFolder = output<void>();
  // AZCO: fired when an admin picks "Collection" from the + menu.
  readonly onAddCollection = output<void>();

  // AZCO: kill text-selection specifically. preventDefault on `selectstart`
  // stops Chromium from painting a multi-row highlight on click-drag without
  // blocking the click or the HTML5 drag session. preventDefault on mousedown
  // would block drag entirely.
  onCipherSelectStart(event: Event) {
    event.preventDefault();
  }

  // AZCO: HTML5 drag source for cipher rows.
  onCipherDragStart(event: DragEvent, cipher: any) {
    // Nuke any text selection that may have started on mousedown. Without
    // this, Chromium keeps the highlight painted across multiple rows for
    // the duration of the drag even though only the clicked row is actually
    // what moves — the selection is cosmetic-only but very distracting.
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    if (!event.dataTransfer || !cipher?.id) {
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    const payload = {
      cipherId: cipher.id,
      organizationId: cipher.organizationId ?? null,
      name: cipher.name ?? "",
    };
    try {
      event.dataTransfer.setData("application/x-azco-cipher", JSON.stringify(payload));
      event.dataTransfer.setData("text/plain", cipher.id);
    } catch {
      /* drag cancelled */
    }

    // AZCO: use a custom drag image. Without this, Chromium snapshots the
    // source button WITH its cdk-virtual-scroll transform applied, which
    // makes the drag image appear offset and visually overlap neighbor rows
    // — giving the impression that multiple rows are being dragged. A clean
    // detached pill sidesteps the problem and reads better anyway.
    try {
      const ghost = document.createElement("div");
      ghost.textContent = cipher.name ?? "item";
      ghost.setAttribute(
        "style",
        [
          "position: absolute",
          "top: -1000px",
          "left: -1000px",
          "padding: 8px 14px",
          "background: #005db9",
          "color: #ffffff",
          "border-radius: 999px",
          "font: 600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          "box-shadow: 0 4px 12px rgba(0,0,0,0.35)",
          "pointer-events: none",
          "white-space: nowrap",
          "max-width: 320px",
          "overflow: hidden",
          "text-overflow: ellipsis",
        ].join(";"),
      );
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 14, 14);
      setTimeout(() => {
        try {
          document.body.removeChild(ghost);
        } catch {
          /* already removed */
        }
      }, 0);
    } catch {
      /* setDragImage not supported — fall back to browser default */
    }
  }

  onCipherDragEnd() {
    // eslint-disable-next-line no-console
    console.log("[AZCO drag] dragend fired");
  }

  protected CipherViewLikeUtils = CipherViewLikeUtils;

  constructor(
    searchService: SearchService,
    private readonly searchBarService: SearchBarService,
    cipherService: CipherService,
    accountService: AccountService,
    restrictedItemTypesService: RestrictedItemTypesService,
    configService: ConfigService,
    private premiumUpgradePromptService: PremiumUpgradePromptService,
  ) {
    super(searchService, cipherService, accountService, restrictedItemTypesService, configService);

    this.searchBarService.searchText$
      .pipe(debounceTime(SearchTextDebounceInterval), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe((searchText) => {
        this.searchText = searchText!;
      });
  }

  async navigateToGetPremium() {
    await this.premiumUpgradePromptService.promptForPremium();
  }

  trackByFn(index: number, c: C): string {
    return uuidAsString(c.id!);
  }
}
