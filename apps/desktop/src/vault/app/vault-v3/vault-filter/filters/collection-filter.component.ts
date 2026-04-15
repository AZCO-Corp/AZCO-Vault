import { Component, inject, input, computed, output } from "@angular/core";
import { firstValueFrom } from "rxjs";

import {
  CollectionAdminService,
  CollectionService,
  DefaultCollectionAdminService,
} from "@bitwarden/admin-console/common";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { EncryptService } from "@bitwarden/common/key-management/crypto/abstractions/encrypt.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CollectionId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { TreeNode } from "@bitwarden/common/vault/models/domain/tree-node";
import {
  NavigationModule,
  A11yTitleDirective,
  DialogService,
  ToastService,
} from "@bitwarden/components";
import { KeyService } from "@bitwarden/key-management";
import { VaultFilter, CollectionFilter } from "@bitwarden/vault";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-collection-filter",
  templateUrl: "collection-filter.component.html",
  imports: [A11yTitleDirective, NavigationModule],
  // AZCO: the collection admin service needs to be instantiated here for the
  // move-cipher confirmation, which uses the admin view to count members on
  // the target collection. Same factory pattern as the admin dialog since
  // DefaultCollectionAdminService isn't @Injectable.
  providers: [
    {
      provide: CollectionAdminService,
      useFactory: (
        apiService: ApiService,
        keyService: KeyService,
        encryptService: EncryptService,
        collectionService: CollectionService,
        organizationService: OrganizationService,
      ) =>
        new DefaultCollectionAdminService(
          apiService,
          keyService,
          encryptService,
          collectionService,
          organizationService,
        ),
      deps: [ApiService, KeyService, EncryptService, CollectionService, OrganizationService],
    },
  ],
})
export class CollectionFilterComponent {
  private cipherService = inject(CipherService);
  private accountService = inject(AccountService);
  private dialogService = inject(DialogService);
  private toastService = inject(ToastService);
  private logService = inject(LogService);
  private syncService = inject(SyncService);
  private collectionAdminService = inject(CollectionAdminService);

  protected readonly collection = input.required<TreeNode<CollectionFilter>>();
  protected readonly activeFilter = input<VaultFilter>();

  // AZCO: toggled true while a drag is hovering this row.
  protected dropHover = false;
  // AZCO: when true, a pencil edit affordance is rendered next to the
  // collection row and the editCollection output fires on click.
  readonly canEdit = input<boolean>(false);
  readonly editCollection = output<TreeNode<CollectionFilter>>();

  protected readonly displayName = computed<string>(() => {
    return this.collection().node.name;
  });

  protected readonly isActive = computed<boolean>(() => {
    return (
      this.collection().node.id === this.activeFilter()?.collectionId &&
      !!this.activeFilter()?.selectedCollectionNode
    );
  });

  protected applyFilter(event: Event) {
    event.stopPropagation();

    const filter = this.activeFilter();

    if (filter) {
      filter.selectedCollectionNode = this.collection();
    }
  }

  protected onEditClick(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    this.editCollection.emit(this.collection());
  }

  // ─────────────────────────────────────────────────────────────────
  // AZCO: drop target for cipher rows dragged from the item list.
  // On drop we validate same-org, look up the target collection's
  // member count via the admin service, open a confirm dialog, and
  // on confirm set the cipher's collectionIds to [target] and save.
  // ─────────────────────────────────────────────────────────────────

  protected onDropDragOver(event: DragEvent) {
    if (!event.dataTransfer) {
      return;
    }
    const hasCipher = Array.from(event.dataTransfer.types).some(
      (t) => t === "application/x-azco-cipher" || t === "text/plain",
    );
    if (!hasCipher) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    this.dropHover = true;
  }

  protected onDropDragLeave() {
    this.dropHover = false;
  }

  protected async onDrop(event: DragEvent) {
    this.dropHover = false;
    if (!event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    let payload: { cipherId: string; organizationId: string | null; name: string } | null = null;
    try {
      const raw = event.dataTransfer.getData("application/x-azco-cipher");
      if (raw) {
        payload = JSON.parse(raw);
      }
    } catch {
      payload = null;
    }
    if (!payload) {
      const id = event.dataTransfer.getData("text/plain");
      if (id) {
        payload = { cipherId: id, organizationId: null, name: "this item" };
      }
    }
    if (!payload?.cipherId) {
      return;
    }

    await this.moveCipher(payload);
  }

  private async moveCipher(payload: {
    cipherId: string;
    organizationId: string | null;
    name: string;
  }): Promise<void> {
    const targetNode = this.collection();
    const target = targetNode.node;
    const targetOrgId = (target as any).organizationId?.toString() ?? null;
    const targetName = target.name;
    const targetId = target.id?.toString();

    if (!targetId) {
      return;
    }

    // ── Validate same-org (or personal → org rejection) ─────────────
    if (!targetOrgId) {
      // Target collection isn't owned by an organization — should never
      // happen in the sidebar tree but bail just in case.
      return;
    }
    if (payload.organizationId == null) {
      this.toastService.showToast({
        variant: "error",
        title: null,
        message:
          "This item is in your personal vault. Share it to an organization first before moving it into a collection.",
      });
      return;
    }
    if (payload.organizationId !== targetOrgId) {
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: "Can't move items between organizations. Use Share to Organization first.",
      });
      return;
    }

    // ── Load cipher view + optional member count ─────────────────────
    let userId: any;
    try {
      userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
    } catch {
      return;
    }

    const allCiphers = await firstValueFrom(this.cipherService.cipherViews$(userId));
    const cipherView = (allCiphers ?? []).find((c: any) => c.id === payload.cipherId);
    if (!cipherView) {
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: "Could not find that item in the current vault state.",
      });
      return;
    }

    // Already in the target? nothing to do.
    const currentCollectionIds = (cipherView.collectionIds ?? []).map((x: any) => x?.toString());
    if (currentCollectionIds.length === 1 && currentCollectionIds[0] === targetId) {
      this.toastService.showToast({
        variant: "info",
        title: null,
        message: `Already in "${targetName}".`,
      });
      return;
    }

    // Best-effort member + group count lookup via the admin view. Non-admins
    // will fail here (the admin endpoint is gated) and we fall through to
    // a simpler access summary in the confirm text.
    let memberCount: number | null = null;
    let groupCount: number | null = null;
    try {
      const adminViews = await firstValueFrom(
        this.collectionAdminService.collectionAdminViews$(targetOrgId, userId),
      );
      const full = adminViews.find((c) => c.id?.toString() === targetId);
      if (full) {
        memberCount = (full.users ?? []).length;
        groupCount = (full.groups ?? []).length;
      }
    } catch {
      memberCount = null;
      groupCount = null;
    }

    // ── Confirmation dialog ─────────────────────────────────────────
    const itemName = payload.name || cipherView.name || "this item";
    const sourceCount = currentCollectionIds.length;
    const sourceLine =
      sourceCount === 0
        ? "Currently not assigned to any collection in this organization."
        : sourceCount === 1
          ? "Will be removed from the collection it's currently in."
          : `Will be removed from the ${sourceCount} collections it's currently in.`;

    let accessLine: string;
    if (memberCount != null) {
      const who: string[] = [];
      if (memberCount > 0) {
        who.push(`${memberCount} member${memberCount === 1 ? "" : "s"}`);
      }
      if (groupCount != null && groupCount > 0) {
        who.push(`${groupCount} group${groupCount === 1 ? "" : "s"}`);
      }
      accessLine =
        who.length === 0
          ? `No members or groups are assigned to "${targetName}" — only organization admins will see the item there.`
          : `${who.join(" and ")} assigned to "${targetName}" will have access.`;
    } else {
      accessLine = `Anyone with access to "${targetName}" will see this item.`;
    }

    const content = [
      `You're about to move "${itemName}" to "${targetName}".`,
      "",
      `• ${sourceLine}`,
      `• ${accessLine}`,
      `• The item stays in the same organization — only its collection membership changes.`,
      `• You can undo this by dragging it back to another collection.`,
    ].join("\n");

    const confirmed = await this.dialogService.openSimpleDialog({
      title: `Move to "${targetName}"?`,
      content,
      type: "warning",
      acceptButtonText: "Move",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) {
      return;
    }

    // ── Apply ──────────────────────────────────────────────────────
    try {
      cipherView.collectionIds = [targetId as CollectionId];
      const { cipher } = await this.cipherService.encrypt(cipherView, userId);
      await this.cipherService.saveCollectionsWithServer(cipher, userId);
      try {
        await this.syncService.fullSync(true);
      } catch {
        /* non-fatal */
      }
      this.toastService.showToast({
        variant: "success",
        title: null,
        message: `Moved to "${targetName}".`,
      });
    } catch (e) {
      this.logService.error(e);
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: `Move failed: ${(e as Error)?.message ?? "unknown error"}`,
      });
    }
  }
}
