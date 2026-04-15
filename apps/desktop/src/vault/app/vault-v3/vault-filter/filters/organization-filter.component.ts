// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { Component, computed, input, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { DisplayMode } from "@bitwarden/angular/vault/vault-filter/models/display-mode";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { TreeNode } from "@bitwarden/common/vault/models/domain/tree-node";
import {
  ToastService,
  NavigationModule,
  A11yTitleDirective,
  DialogService,
  IconModule,
} from "@bitwarden/components";
import { I18nPipe } from "@bitwarden/ui-common";
import {
  CollectionFilter,
  OrganizationFilter,
  VaultFilter,
  VaultFilterServiceAbstraction,
} from "@bitwarden/vault";

import {
  CollectionAdminDialogComponent,
  CollectionAdminDialogResult,
} from "../collection-admin-dialog/collection-admin-dialog.component";

import { CollectionFilterComponent } from "./collection-filter.component";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-organization-filter",
  templateUrl: "organization-filter.component.html",
  imports: [A11yTitleDirective, CollectionFilterComponent, NavigationModule, I18nPipe, IconModule],
})
export class OrganizationFilterComponent {
  private toastService: ToastService = inject(ToastService);
  private i18nService: I18nService = inject(I18nService);
  private vaultFilterService: VaultFilterServiceAbstraction = inject(VaultFilterServiceAbstraction);
  private dialogService: DialogService = inject(DialogService);

  protected readonly hide = input(false);
  protected readonly organizations = input.required<TreeNode<OrganizationFilter>>();
  protected readonly activeFilter = input<VaultFilter>();
  protected readonly activeOrganizationDataOwnership = input<boolean>(false);
  protected readonly activeSingleOrganizationPolicy = input<boolean>(false);
  // AZCO: collection tree, used to render per-org collections inline.
  protected readonly collections = input<TreeNode<CollectionFilter> | undefined>(undefined);

  // AZCO: return the top-level collection nodes that belong to a given org.
  protected collectionsForOrg(orgId: string): TreeNode<CollectionFilter>[] {
    return (this.collections()?.children ?? []).filter((c) => c.node.organizationId === orgId);
  }

  // AZCO: true if the signed-in user can create/edit collections in this org.
  protected canEditCollections(org: TreeNode<OrganizationFilter>): boolean {
    return !!(org?.node as any)?.canEditAnyCollection;
  }

  protected async newCollection(event: Event, org: TreeNode<OrganizationFilter>) {
    event.stopPropagation();
    const dialogRef = CollectionAdminDialogComponent.open(this.dialogService, {
      data: { organizationId: org.node.id },
    });
    const result = (await firstValueFrom(dialogRef.closed)) as CollectionAdminDialogResult;
    if (result === "saved") {
      (this.vaultFilterService as any).reloadCollections?.();
    }
  }

  protected async editCollection(
    event: Event,
    org: TreeNode<OrganizationFilter>,
    collection: TreeNode<CollectionFilter>,
  ) {
    event.stopPropagation();
    event.preventDefault();
    const dialogRef = CollectionAdminDialogComponent.open(this.dialogService, {
      data: {
        organizationId: org.node.id,
        collection: collection.node as any,
      },
    });
    const result = (await firstValueFrom(dialogRef.closed)) as CollectionAdminDialogResult;
    if (result === "saved" || result === "deleted") {
      (this.vaultFilterService as any).reloadCollections?.();
    }
  }

  protected readonly show = computed(() => {
    const hiddenDisplayModes: DisplayMode[] = [
      "singleOrganizationAndOrganizatonDataOwnershipPolicies",
    ];
    return (
      !this.hide() &&
      this.organizations()?.children.length > 0 &&
      hiddenDisplayModes.indexOf(this.displayMode()) === -1
    );
  });

  protected readonly displayMode = computed<DisplayMode>(() => {
    let displayMode: DisplayMode = "organizationMember";
    if (this.organizations() == null || this.organizations().children.length < 1) {
      displayMode = "noOrganizations";
    } else if (this.activeOrganizationDataOwnership() && !this.activeSingleOrganizationPolicy()) {
      displayMode = "organizationDataOwnershipPolicy";
    } else if (!this.activeOrganizationDataOwnership() && this.activeSingleOrganizationPolicy()) {
      displayMode = "singleOrganizationPolicy";
    } else if (this.activeOrganizationDataOwnership() && this.activeSingleOrganizationPolicy()) {
      displayMode = "singleOrganizationAndOrganizatonDataOwnershipPolicies";
    }

    return displayMode;
  });

  protected applyFilter(event: Event, organization: TreeNode<OrganizationFilter>) {
    event.stopPropagation();

    this.vaultFilterService.setOrganizationFilter(organization.node);
    const filter = this.activeFilter();

    if (filter) {
      filter.selectedOrganizationNode = organization;
    }
  }

  protected applyAllVaultsFilter() {
    this.vaultFilterService.clearOrganizationFilter();
    const filter = this.activeFilter();

    if (filter) {
      filter.selectedOrganizationNode = null;
    }
  }
}
