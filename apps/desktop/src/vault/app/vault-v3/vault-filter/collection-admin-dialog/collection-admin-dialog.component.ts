// AZCO: create / rename / delete collections with per-member access.
// Surfaces the existing CollectionAdminService + OrganizationUserApiService
// (both already provided in the desktop DI container) through a small
// dialog reachable from the org filter nav group.

import { DialogConfig } from "@angular/cdk/dialog";
import { CommonModule } from "@angular/common";
import { Component, inject, Inject, OnInit } from "@angular/core";
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
import { OrganizationUserStatusType } from "@bitwarden/common/admin-console/enums";
import {
  CollectionAccessSelectionView,
  CollectionAdminView,
} from "@bitwarden/common/admin-console/models/collections";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { EncryptService } from "@bitwarden/common/key-management/crypto/abstractions/encrypt.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { CollectionId, OrganizationId } from "@bitwarden/common/types/guid";
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

export interface CollectionAdminDialogParams {
  organizationId: string;
  /** When present, the dialog is in edit mode for this existing collection. */
  collection?: CollectionAdminView;
}

export type CollectionAdminDialogResult = "saved" | "deleted" | "canceled";

type CollectionForm = FormGroup<{
  name: FormControl<string>;
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
  // @Injectable()-decorated, so we construct it via a factory with explicit
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
  private collectionAdminService = inject(CollectionAdminService);
  private organizationUserApiService = inject(OrganizationUserApiService);
  private organizationService = inject(OrganizationService);
  private accountService = inject(AccountService);
  private dialogService = inject(DialogService);
  private toastService = inject(ToastService);
  private i18nService = inject(I18nService);
  private logService = inject(LogService);

  protected loading = true;
  protected saving = false;
  protected orgName = "";

  protected form: CollectionForm = new FormGroup({
    name: new FormControl<string>("", {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(1000)],
    }),
  });

  protected members: MemberRow[] = [];

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

  async ngOnInit(): Promise<void> {
    try {
      const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      const orgs = await firstValueFrom(this.organizationService.organizations$(userId));
      const org = orgs.find((o) => o.id === this.data.organizationId);
      this.orgName = org?.name ?? "";

      // Fetch the full list of org members to build the picker.
      const usersList = await this.organizationUserApiService.getAllMiniUserDetails(
        this.data.organizationId,
      );
      const accepted = (usersList?.data ?? []).filter(
        (u) => u.status === OrganizationUserStatusType.Confirmed,
      );

      // Seed the member rows, marking the existing permission if we're editing.
      const existing = new Map<string, CollectionAccessSelectionView>();
      if (this.editMode) {
        this.form.controls.name.setValue(this.data.collection!.name);
        for (const u of this.data.collection!.users ?? []) {
          existing.set(u.id, u);
        }
      }

      this.members = accepted
        .map<MemberRow>((u) => ({
          id: u.id,
          name: u.name || u.email,
          email: u.email,
          permission: this.toPreset(existing.get(u.id)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.logService.error(e);
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: "Could not load organization members.",
      });
    } finally {
      this.loading = false;
    }
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

  private fromPreset(
    preset: PermissionPreset,
    userId: string,
  ): CollectionAccessSelectionView | null {
    if (preset === "none") {
      return null;
    }
    const sel = new CollectionAccessSelectionView({
      id: userId,
      readOnly: preset === "view" || preset === "viewHidden",
      hidePasswords: preset === "viewHidden" || preset === "editHidden",
      manage: preset === "manage",
    });
    return sel;
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving = true;
    try {
      const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));

      const name = this.form.controls.name.value.trim();
      const view = this.editMode
        ? Object.assign(
            new CollectionAdminView({
              id: this.data.collection!.id as CollectionId,
              organizationId: this.data.organizationId as OrganizationId,
              name,
            }),
            this.data.collection,
          )
        : new CollectionAdminView({
            id: undefined as unknown as CollectionId,
            organizationId: this.data.organizationId as OrganizationId,
            name,
          });
      view.name = name;
      view.organizationId = this.data.organizationId as OrganizationId;

      view.users = this.members
        .map((m) => this.fromPreset(m.permission, m.id))
        .filter((s): s is CollectionAccessSelectionView => s != null);

      // Preserve any existing group assignments when editing; we don't manage groups in v1.
      if (!this.editMode) {
        view.groups = [];
      }

      if (this.editMode) {
        await this.collectionAdminService.update(view, userId);
      } else {
        await this.collectionAdminService.create(view, userId);
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
    const confirmed = await this.dialogService.openSimpleDialog({
      title: { key: "deleteCollection" },
      content: { key: "deleteCollectionConfirmation" },
      type: "warning",
    });
    if (!confirmed) {
      return;
    }
    this.saving = true;
    try {
      await this.collectionAdminService.delete(this.data.organizationId, this.data.collection.id);
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
