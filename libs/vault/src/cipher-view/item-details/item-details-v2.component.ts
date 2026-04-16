// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule } from "@angular/common";
import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from "@angular/core";
// This import has been flagged as unallowed for this class. It may be involved in a circular dependency loop.
import { toSignal } from "@angular/core/rxjs-interop";
import { firstValueFrom, fromEvent, map, startWith } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { ClientType } from "@bitwarden/client-type";
import {
  CollectionView,
  CollectionTypes,
} from "@bitwarden/common/admin-console/models/collections";
import { Organization } from "@bitwarden/common/admin-console/models/domain/organization";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FolderView } from "@bitwarden/common/vault/models/view/folder.view";
import {
  BadgeModule,
  CardComponent,
  FormFieldModule,
  LinkComponent,
  ToastService,
  TypographyModule,
} from "@bitwarden/components";

import { OrgIconDirective } from "../../components/org-icon.directive";
import { AzcoCustomIconService } from "../../services/azco-custom-icon.service";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-item-details-v2",
  templateUrl: "item-details-v2.component.html",
  imports: [
    CommonModule,
    JslibModule,
    CardComponent,
    TypographyModule,
    OrgIconDirective,
    FormFieldModule,
    LinkComponent,
    BadgeModule,
  ],
})
export class ItemDetailsV2Component {
  readonly hideOwner = input<boolean>(false);
  readonly cipher = input.required<CipherView>();
  readonly organization = input<Organization | undefined>();
  readonly folder = input<FolderView | undefined>();
  readonly collections = input<CollectionView[] | undefined>();
  readonly showAllDetails = signal(false);

  readonly showOwnership = computed(() => {
    return this.cipher().organizationId && this.organization() && !this.hideOwner();
  });

  readonly hasSmallScreen = toSignal(
    fromEvent(window, "resize").pipe(
      map(() => window.innerWidth),
      startWith(window.innerWidth),
      map((width) => width < 681),
    ),
  );

  // Array to hold all details of item. Organization, Collections, and Folder
  readonly allItems = computed(() => {
    let items: any[] = [];
    if (this.showOwnership() && this.organization()) {
      items.push(this.organization());
    }
    if (this.cipher().collectionIds?.length > 0 && this.collections()) {
      items = [...items, ...this.collections()];
    }
    if (this.cipher().folderId && this.folder()) {
      items.push(this.folder());
    }
    return items;
  });

  readonly showItems = computed(() => {
    if (
      this.hasSmallScreen() &&
      this.allItems().length > 2 &&
      !this.showAllDetails() &&
      this.cipher().collectionIds?.length > 1
    ) {
      return this.allItems().slice(0, 2);
    } else {
      return this.allItems();
    }
  });

  protected readonly showArchiveBadge = computed(() => {
    return (
      this.cipher().isArchived && this.platformUtilsService.getClientType() === ClientType.Desktop
    );
  });

  constructor(
    private i18nService: I18nService,
    private platformUtilsService: PlatformUtilsService,
  ) {
    // Sync local icon URL whenever the parent pushes a new cipher reference.
    effect(() => {
      this.azcoIconUrl.set(this.azcoCustomIconService.readCustomIcon(this.cipher()));
    });
  }

  toggleShowMore() {
    this.showAllDetails.update((value) => !value);
  }

  getAriaLabel(item: Organization | CollectionView | FolderView): string {
    if (item instanceof Organization) {
      return this.i18nService.t("owner") + item.name;
    } else if (item instanceof CollectionView) {
      return this.i18nService.t("collection") + item.name;
    } else if (item instanceof FolderView) {
      return this.i18nService.t("folder") + item.name;
    }
    return "";
  }

  getIconClass(item: Organization | CollectionView | FolderView): string {
    if (item instanceof CollectionView) {
      return item.type === CollectionTypes.DefaultUserCollection
        ? "bwi-user"
        : "bwi-collection-shared";
    } else if (item instanceof FolderView) {
      return "bwi-folder";
    }
    return "";
  }

  getItemTitle(item: Organization | CollectionView | FolderView): string {
    if (item instanceof CollectionView) {
      return this.i18nService.t("collection");
    } else if (item instanceof FolderView) {
      return this.i18nService.t("folder");
    }
    return "";
  }

  isOrgIcon(item: Organization | CollectionView | FolderView): boolean {
    return item instanceof Organization;
  }

  // ─── AZCO: per-cipher custom icon (click to upload, hover × to remove) ───
  // The icon is stored as a hidden custom field (`__azco_icon`) on the
  // cipher; AzcoCustomIconService handles read/write/resize. The icon
  // also rides along on share links (see item-footer.component.ts).
  readonly azcoIconFileInput = viewChild<ElementRef<HTMLInputElement>>("azcoIconFileInput");

  protected readonly azcoIconBusy = signal(false);

  // Local icon URL signal — tracks the custom icon independently of the
  // cipher input signal so the open item view refreshes immediately after
  // save (the parent's cipher() reference doesn't change on in-place
  // field mutation, so app-vault-icon's computed would stay stale).
  protected readonly azcoIconUrl = signal<string | null>(null);

  private readonly azcoCustomIconService = inject(AzcoCustomIconService);
  private readonly azcoCipherService = inject(CipherService);
  private readonly azcoAccountService = inject(AccountService);
  private readonly azcoToastService = inject(ToastService);
  private readonly azcoLogService = inject(LogService);
  private readonly azcoSyncService = inject(SyncService);

  protected readonly azcoHasCustomIcon = computed(() => {
    return this.azcoIconUrl() != null;
  });

  protected readonly azcoCanEditIcon = computed(() => {
    const c = this.cipher();
    return !!c && c.edit === true && !c.isDeleted;
  });

  protected onAzcoIconClick(): void {
    if (!this.azcoCanEditIcon() || this.azcoIconBusy()) {
      return;
    }
    this.azcoIconFileInput()?.nativeElement.click();
  }

  protected async onAzcoIconFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // reset so picking the same file twice still fires (change)
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      this.azcoToastService.showToast({
        variant: "error",
        title: null,
        message: "Custom icon must be an image file.",
      });
      return;
    }
    const MAX_INPUT_BYTES = 2 * 1024 * 1024;
    if (file.size > MAX_INPUT_BYTES) {
      this.azcoToastService.showToast({
        variant: "error",
        title: null,
        message: "Custom icon image is too large (2 MB max).",
      });
      return;
    }

    this.azcoIconBusy.set(true);
    try {
      const dataUrl = await this.azcoCustomIconService.resizeImageToDataUrl(file);
      const cipher = this.cipher();
      this.azcoCustomIconService.writeCustomIcon(cipher, dataUrl);
      await this.azcoSaveCipher(cipher);
      this.azcoIconUrl.set(dataUrl);
      this.azcoToastService.showToast({
        variant: "success",
        title: null,
        message: "Icon updated.",
      });
    } catch (e) {
      this.azcoLogService.error(e);
      this.azcoToastService.showToast({
        variant: "error",
        title: null,
        message: `Could not update icon: ${(e as Error)?.message ?? "unknown error"}`,
      });
    } finally {
      this.azcoIconBusy.set(false);
    }
  }

  protected async onAzcoIconRemove(event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.azcoCanEditIcon() || this.azcoIconBusy()) {
      return;
    }
    this.azcoIconBusy.set(true);
    try {
      const cipher = this.cipher();
      this.azcoCustomIconService.writeCustomIcon(cipher, null);
      await this.azcoSaveCipher(cipher);
      this.azcoIconUrl.set(null);
      this.azcoToastService.showToast({
        variant: "success",
        title: null,
        message: "Icon removed.",
      });
    } catch (e) {
      this.azcoLogService.error(e);
      this.azcoToastService.showToast({
        variant: "error",
        title: null,
        message: `Could not remove icon: ${(e as Error)?.message ?? "unknown error"}`,
      });
    } finally {
      this.azcoIconBusy.set(false);
    }
  }

  private async azcoSaveCipher(cipher: CipherView): Promise<void> {
    const userId = await firstValueFrom(this.azcoAccountService.activeAccount$.pipe(getUserId));
    const updated = await this.azcoCipherService.updateWithServer(cipher, userId);
    // Copy server-side metadata back so the next save in the same session
    // doesn't fail the "client copy is out of date" staleness check.
    cipher.revisionDate = updated.revisionDate;
    // fullSync forces the sidebar to re-render with the new icon.
    await this.azcoSyncService.fullSync(true);
  }
}
