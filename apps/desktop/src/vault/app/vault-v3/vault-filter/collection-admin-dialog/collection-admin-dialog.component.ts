// AZCO: create / rename / delete collections with per-member and per-group
// access, reachable from the "+ New collection" entry in the vault list's
// add-item menu and from the pencil affordance on each existing collection
// in the sidebar. The caller may or may not pre-select an organization; if
// none is passed, the dialog renders an organization picker based on the
// orgs where the current user has canEditAnyCollection.

import { DialogConfig } from "@angular/cdk/dialog";
import { CommonModule } from "@angular/common";
import { Component, Inject, OnInit, inject } from "@angular/core";
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { firstValueFrom } from "rxjs";

import {
  CollectionAdminService,
  CollectionService,
  DefaultCollectionAdminService,
  OrganizationUserApiService,
} from "@bitwarden/admin-console/common";
import { JslibModule } from "@bitwarden/angular/jslib.module";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { OrganizationService } from "@bitwarden/common/admin-console/abstractions/organization/organization.service.abstraction";
import {
  CollectionAccessSelectionView,
  CollectionAdminView,
} from "@bitwarden/common/admin-console/models/collections";
import { Organization } from "@bitwarden/common/admin-console/models/domain/organization";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { EncryptService } from "@bitwarden/common/key-management/crypto/abstractions/encrypt.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CollectionId, OrganizationId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  ButtonModule,
  DIALOG_DATA,
  DialogModule,
  DialogRef,
  DialogService,
  FormFieldModule,
  InputModule,
  SelectModule,
  ToastService,
} from "@bitwarden/components";
import { KeyService } from "@bitwarden/key-management";

type PermissionPreset = "none" | "view" | "viewHidden" | "edit" | "editHidden" | "manage";

interface MemberRow {
  id: string;
  name: string;
  email: string;
  permission: PermissionPreset;
}

interface GroupRow {
  id: string;
  name: string;
  permission: PermissionPreset;
}

interface ParentOption {
  id: string; // "" = top level
  fullName: string;
}

export interface CollectionAdminDialogParams {
  /** When omitted, the dialog shows an org picker. */
  organizationId?: string;
  /** When present, the dialog is in edit mode for this existing collection. */
  collection?: CollectionAdminView;
}

export type CollectionAdminDialogResult = "saved" | "deleted" | "canceled";

type CollectionForm = FormGroup<{
  organizationId: FormControl<string>;
  parentId: FormControl<string>;
  leafName: FormControl<string>;
}>;

// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  templateUrl: "collection-admin-dialog.component.html",
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    FormFieldModule,
    FormsModule,
    InputModule,
    JslibModule,
    ReactiveFormsModule,
    SelectModule,
  ],
  // CollectionAdminService has no global provider in the desktop app (it's
  // only registered for apps/web). DefaultCollectionAdminService itself isn't
  // @Injectable-decorated, so we construct it via a factory with explicit
  // deps. All of the underlying services are already provided globally in
  // apps/desktop/src/app/services/services.module.ts.
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
export class CollectionAdminDialogComponent implements OnInit {
  private apiService = inject(ApiService);
  private collectionAdminService = inject(CollectionAdminService);
  private organizationUserApiService = inject(OrganizationUserApiService);
  private organizationService = inject(OrganizationService);
  private accountService = inject(AccountService);
  private dialogService = inject(DialogService);
  private toastService = inject(ToastService);
  private logService = inject(LogService);
  private syncService = inject(SyncService);
  private cipherService = inject(CipherService);

  protected loading = true;
  protected loadingOrgContext = false;
  protected saving = false;
  protected cipherCount = 0;

  protected availableOrgs: Organization[] = [];
  protected members: MemberRow[] = [];
  protected groups: GroupRow[] = [];
  protected parentOptions: ParentOption[] = [];

  private currentUserOrganizationUserId: string | null = null;
  private existingAdminView: CollectionAdminView | null = null;

  protected form: CollectionForm = new FormGroup({
    organizationId: new FormControl<string>("", {
      nonNullable: true,
      validators: [Validators.required],
    }),
    parentId: new FormControl<string>("", { nonNullable: true }),
    leafName: new FormControl<string>("", {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(500)],
    }),
  });

  protected readonly permissionOptions: { value: PermissionPreset; label: string }[] = [
    { value: "none", label: "No access" },
    { value: "view", label: "Can view" },
    { value: "viewHidden", label: "Can view (hide passwords)" },
    { value: "edit", label: "Can edit" },
    { value: "editHidden", label: "Can edit (hide passwords)" },
    { value: "manage", label: "Can manage" },
  ];

  constructor(
    @Inject(DIALOG_DATA) protected data: CollectionAdminDialogParams,
    private dialogRef: DialogRef<CollectionAdminDialogResult>,
  ) {}

  get editMode(): boolean {
    return this.data.collection != null;
  }

  get showOrgPicker(): boolean {
    return !this.editMode && this.availableOrgs.length > 1;
  }

  async ngOnInit(): Promise<void> {
    try {
      const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      const allOrgs = await firstValueFrom(this.organizationService.organizations$(userId));
      // Only orgs where the signed-in user can manage collections. Admin/Owner
      // role is the right gate here — canEditAnyCollection requires the org's
      // allowAdminAccessToAllCollectionItems setting, which Vaultwarden returns
      // as false by default.
      this.availableOrgs = (allOrgs ?? []).filter(
        (o) => (o as any).isAdmin || (o as any).isOwner || (o as any).canCreateNewCollections,
      );

      if (this.availableOrgs.length === 0) {
        this.toastService.showToast({
          variant: "error",
          title: null,
          message: "You don't have permission to manage collections in any organization.",
        });
        this.dialogRef.close("canceled");
        return;
      }

      // Decide the initial org: explicit > edit target > first available.
      let initialOrgId =
        this.data.organizationId ??
        this.data.collection?.organizationId?.toString() ??
        this.availableOrgs[0].id;
      if (!this.availableOrgs.some((o) => o.id === initialOrgId)) {
        initialOrgId = this.availableOrgs[0].id;
      }
      this.form.controls.organizationId.setValue(initialOrgId);

      // Editing is org-locked — you can't move a collection between orgs.
      if (this.editMode) {
        this.form.controls.organizationId.disable();
      }

      await this.loadOrgContext(initialOrgId);

      // Prefill the name fields from the existing collection (edit mode).
      if (this.editMode && this.existingAdminView) {
        this.applyNameToForm(this.existingAdminView.name);
      }
    } catch (e) {
      this.logService.error(e);
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: "Could not load organization data.",
      });
    } finally {
      this.loading = false;
    }
  }

  /**
   * Fetch everything that depends on the selected org: full admin views for
   * the parent-collection picker, member list, group list, and (edit mode
   * only) the ciphered items count for the delete confirmation.
   */
  protected async loadOrgContext(orgId: string): Promise<void> {
    if (!orgId) {
      return;
    }
    this.loadingOrgContext = true;
    try {
      const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      const org = this.availableOrgs.find((o) => o.id === orgId);
      this.currentUserOrganizationUserId = (org as any)?.organizationUserId ?? null;

      // --- Collection admin views (parent picker + existing users/groups) ---
      let adminViews: CollectionAdminView[] = [];
      try {
        adminViews = await firstValueFrom(
          this.collectionAdminService.collectionAdminViews$(orgId, userId),
        );
      } catch (e) {
        this.logService.error(e);
        adminViews = [];
      }

      // Parent picker: all collections in the org, minus the one being edited.
      const editId = this.editMode ? this.data.collection?.id?.toString() : null;
      this.parentOptions = [
        { id: "", fullName: "— none (top level) —" },
        ...adminViews
          .filter((c) => c.id?.toString() !== editId)
          .map<ParentOption>((c) => ({ id: c.id!.toString(), fullName: c.name }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      ];

      // If we're editing, stash the fresh admin view so users/groups prefill.
      if (this.editMode && editId) {
        this.existingAdminView = adminViews.find((c) => c.id?.toString() === editId) ?? null;
      } else {
        this.existingAdminView = null;
      }

      // --- Members ---
      const usersList = await this.organizationUserApiService.getAllMiniUserDetails(orgId);
      const allUsers = usersList?.data ?? [];
      const existingUserMap = new Map<string, CollectionAccessSelectionView>();
      for (const u of this.existingAdminView?.users ?? []) {
        existingUserMap.set(u.id, u);
      }
      this.members = allUsers
        .map<MemberRow>((u) => ({
          id: u.id,
          name: u.name?.trim() || u.email || "(unnamed user)",
          email: u.email ?? "",
          permission: this.toPreset(existingUserMap.get(u.id)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // --- Groups (via direct HTTP; no shared lib service exists in libs/common) ---
      try {
        const groupsResp: any = await this.apiService.send(
          "GET",
          `/organizations/${orgId}/groups/details`,
          null,
          true,
          true,
        );
        const groupList: Array<{ id: string; name: string }> = (groupsResp?.data ?? []).map(
          (g: any) => ({ id: g.id ?? g.Id, name: g.name ?? g.Name }),
        );
        const existingGroupMap = new Map<string, CollectionAccessSelectionView>();
        for (const g of this.existingAdminView?.groups ?? []) {
          existingGroupMap.set(g.id, g);
        }
        this.groups = groupList
          .map<GroupRow>((g) => ({
            id: g.id,
            name: g.name ?? "(unnamed group)",
            permission: this.toPreset(existingGroupMap.get(g.id)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // VW instances without groups support, or network hiccup — just hide the section.
        this.groups = [];
      }

      // --- Cipher count for delete confirmation (edit mode only) ---
      if (this.editMode && editId) {
        try {
          const allCiphers = await firstValueFrom(this.cipherService.cipherViews$(userId));
          this.cipherCount = (allCiphers ?? []).filter((c) =>
            (c.collectionIds ?? []).map((x) => x?.toString()).includes(editId),
          ).length;
        } catch {
          this.cipherCount = 0;
        }
      }
    } finally {
      this.loadingOrgContext = false;
    }
  }

  /**
   * Split a "Parent/Child/Grand" name into parent selection + leaf.
   * If the parent doesn't exist in the fresh parentOptions list, we fall back
   * to treating the entire name as the leaf.
   */
  private applyNameToForm(fullName: string): void {
    const lastSlash = fullName.lastIndexOf("/");
    if (lastSlash < 0) {
      this.form.controls.parentId.setValue("");
      this.form.controls.leafName.setValue(fullName);
      return;
    }
    const parentName = fullName.slice(0, lastSlash);
    const leaf = fullName.slice(lastSlash + 1);
    const parent = this.parentOptions.find((p) => p.fullName === parentName);
    if (parent) {
      this.form.controls.parentId.setValue(parent.id);
      this.form.controls.leafName.setValue(leaf);
    } else {
      this.form.controls.parentId.setValue("");
      this.form.controls.leafName.setValue(fullName);
    }
  }

  protected async onOrgChange(orgId: string): Promise<void> {
    if (this.editMode) {
      return;
    }
    await this.loadOrgContext(orgId);
  }

  private toPreset(sel: CollectionAccessSelectionView | undefined): PermissionPreset {
    if (!sel) {
      return "none";
    }
    if (sel.manage) {
      return "manage";
    }
    if (sel.readOnly) {
      return sel.hidePasswords ? "viewHidden" : "view";
    }
    return sel.hidePasswords ? "editHidden" : "edit";
  }

  private fromPreset(preset: PermissionPreset, id: string): CollectionAccessSelectionView | null {
    if (preset === "none") {
      return null;
    }
    return new CollectionAccessSelectionView({
      id,
      readOnly: preset === "view" || preset === "viewHidden",
      hidePasswords: preset === "viewHidden" || preset === "editHidden",
      manage: preset === "manage",
    });
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving = true;
    try {
      const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      const orgId = this.form.controls.organizationId.value;
      const parentId = this.form.controls.parentId.value;
      const leafName = this.form.controls.leafName.value.trim();

      if (!leafName) {
        this.toastService.showToast({
          variant: "error",
          title: null,
          message: "Name is required.",
        });
        this.saving = false;
        return;
      }

      let fullName = leafName;
      if (parentId) {
        const parent = this.parentOptions.find((p) => p.id === parentId);
        if (parent) {
          fullName = `${parent.fullName}/${leafName}`;
        }
      }

      const view = this.editMode
        ? Object.assign(
            new CollectionAdminView({
              id: this.data.collection!.id as CollectionId,
              organizationId: orgId as OrganizationId,
              name: fullName,
            }),
            this.existingAdminView ?? this.data.collection,
          )
        : new CollectionAdminView({
            id: undefined as unknown as CollectionId,
            organizationId: orgId as OrganizationId,
            name: fullName,
          });
      view.name = fullName;
      view.organizationId = orgId as OrganizationId;

      const selectedUsers = this.members
        .map((m) => this.fromPreset(m.permission, m.id))
        .filter((s): s is CollectionAccessSelectionView => s != null);

      // CRITICAL: always include the creating/editing admin with "manage"
      // permission. Without this, DefaultCollectionAdminService.updateLocalCollections
      // treats the response's `assigned=false` flag as "delete from local cache",
      // which makes the collection vanish from the sidebar immediately after save.
      if (
        this.currentUserOrganizationUserId &&
        !selectedUsers.some((u) => u.id === this.currentUserOrganizationUserId)
      ) {
        selectedUsers.push(
          new CollectionAccessSelectionView({
            id: this.currentUserOrganizationUserId,
            readOnly: false,
            hidePasswords: false,
            manage: true,
          }),
        );
      }

      view.users = selectedUsers;
      view.groups = this.groups
        .map((g) => this.fromPreset(g.permission, g.id))
        .filter((s): s is CollectionAccessSelectionView => s != null);

      if (this.editMode) {
        await this.collectionAdminService.update(view, userId);
      } else {
        await this.collectionAdminService.create(view, userId);
      }

      // Force a full sync so the sidebar's collection tree picks up the
      // new/renamed collection reliably.
      try {
        await this.syncService.fullSync(true);
      } catch {
        /* non-fatal — local cache is already updated */
      }

      this.toastService.showToast({
        variant: "success",
        title: null,
        message: this.editMode ? "Collection updated." : "Collection created.",
      });
      this.dialogRef.close("saved");
    } catch (e) {
      this.logService.error(e);
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: `Save failed: ${(e as Error)?.message ?? "unknown error"}`,
      });
    } finally {
      this.saving = false;
    }
  }

  protected async deleteCollection(): Promise<void> {
    if (!this.editMode || !this.data.collection?.id) {
      return;
    }
    const name = this.existingAdminView?.name ?? this.data.collection.name;
    const countMsg =
      this.cipherCount > 0
        ? ` This collection currently holds ${this.cipherCount} item${this.cipherCount === 1 ? "" : "s"} — they will stay in the organization and move to the root listing.`
        : "";
    const confirmed = await this.dialogService.openSimpleDialog({
      title: `Delete “${name}”?`,
      content: `Are you sure you want to delete this collection?${countMsg}`,
      type: "warning",
      acceptButtonText: "Delete",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) {
      return;
    }
    this.saving = true;
    try {
      await this.collectionAdminService.delete(
        this.data.collection.organizationId!.toString(),
        this.data.collection.id.toString(),
      );
      try {
        await this.syncService.fullSync(true);
      } catch {
        /* non-fatal */
      }
      this.toastService.showToast({
        variant: "success",
        title: null,
        message: "Collection deleted.",
      });
      this.dialogRef.close("deleted");
    } catch (e) {
      this.logService.error(e);
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: `Delete failed: ${(e as Error)?.message ?? "unknown error"}`,
      });
    } finally {
      this.saving = false;
    }
  }

  protected cancel(): void {
    this.dialogRef.close("canceled");
  }

  static open(
    dialogService: DialogService,
    config: DialogConfig<CollectionAdminDialogParams>,
  ): DialogRef<CollectionAdminDialogResult> {
    return dialogService.open<CollectionAdminDialogResult, CollectionAdminDialogParams>(
      CollectionAdminDialogComponent,
      config,
    );
  }
}
