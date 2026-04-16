// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule } from "@angular/common";
import { Component, inject, Input, signal } from "@angular/core";
import { RouterModule } from "@angular/router";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { ViewPasswordHistoryService } from "@bitwarden/common/vault/abstractions/view-password-history.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  CardComponent,
  LinkModule,
  PopoverModule,
  SectionComponent,
  SectionHeaderComponent,
  TypographyModule,
} from "@bitwarden/components";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-item-history-v2",
  templateUrl: "item-history-v2.component.html",
  imports: [
    CommonModule,
    JslibModule,
    RouterModule,
    CardComponent,
    SectionComponent,
    SectionHeaderComponent,
    TypographyModule,
    LinkModule,
    PopoverModule,
  ],
})
export class ItemHistoryV2Component {
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input() cipher: CipherView;

  constructor(private viewPasswordHistoryService: ViewPasswordHistoryService) {}

  get isLogin() {
    return this.cipher.type === CipherType.Login;
  }

  /**
   * View the password history for the cipher.
   */
  async viewPasswordHistory() {
    await this.viewPasswordHistoryService.viewPasswordHistory(this.cipher);
  }

  // ─── AZCO: "Who has access" popover ──────────────────────────────
  private readonly azcoApiService = inject(ApiService);
  private readonly azcoLogService = inject(LogService);

  protected readonly azcoAccessLoading = signal(false);
  protected readonly azcoAccessError = signal<string | null>(null);
  protected readonly azcoAccessData = signal<AzcoCollectionAccess[]>([]);

  get azcoShowAccessButton(): boolean {
    return !!this.cipher?.organizationId && (this.cipher.collectionIds?.length ?? 0) > 0;
  }

  protected async azcoLoadAccess(): Promise<void> {
    if (this.azcoAccessLoading() || this.azcoAccessData().length > 0) {
      return;
    }
    this.azcoAccessLoading.set(true);
    this.azcoAccessError.set(null);

    try {
      const orgId = this.cipher.organizationId;
      if (!orgId) {
        return;
      }

      const collectionsResp = await this.azcoApiService.getManyCollectionsWithAccessDetails(orgId);
      const allCollections = collectionsResp?.data ?? [];

      const cipherCollectionIds = new Set(this.cipher.collectionIds ?? []);
      const relevantCollections = allCollections.filter((col: any) =>
        cipherCollectionIds.has(col.id),
      );

      const memberMap = new Map<string, { name: string; email: string }>();
      try {
        const membersResp: any = await this.azcoApiService.send(
          "GET",
          `/organizations/${orgId}/users/mini-details`,
          null,
          true,
          true,
        );
        for (const u of membersResp?.data ?? []) {
          memberMap.set(u.id ?? u.Id, {
            name: (u.name ?? u.Name ?? "").trim() || u.email || u.Email || "(unnamed)",
            email: u.email ?? u.Email ?? "",
          });
        }
      } catch {
        // Non-admin users may not have access to member details.
      }

      const groupMap = new Map<string, string>();
      try {
        const groupsResp: any = await this.azcoApiService.send(
          "GET",
          `/organizations/${orgId}/groups/details`,
          null,
          true,
          true,
        );
        for (const g of groupsResp?.data ?? []) {
          groupMap.set(g.id ?? g.Id, g.name ?? g.Name ?? "(unnamed group)");
        }
      } catch {
        // Groups endpoint may not be available.
      }

      const result: AzcoCollectionAccess[] = relevantCollections.map((col: any) => {
        const members: AzcoAccessEntry[] = (col.users ?? []).map((u: any) => ({
          name: memberMap.get(u.id)?.name ?? "(unknown user)",
          email: memberMap.get(u.id)?.email ?? "",
          permission: azcoPermissionLabel(u),
          type: "user" as const,
        }));
        const groups: AzcoAccessEntry[] = (col.groups ?? []).map((g: any) => ({
          name: groupMap.get(g.id) ?? "(unknown group)",
          email: "",
          permission: azcoPermissionLabel(g),
          type: "group" as const,
        }));
        return {
          collectionName: col.name ?? "(unnamed collection)",
          members: [...members, ...groups].sort((a, b) => a.name.localeCompare(b.name)),
        };
      });

      this.azcoAccessData.set(result);
    } catch (e) {
      this.azcoLogService.error(e);
      this.azcoAccessError.set("Could not load access details.");
    } finally {
      this.azcoAccessLoading.set(false);
    }
  }
}

interface AzcoAccessEntry {
  name: string;
  email: string;
  permission: string;
  type: "user" | "group";
}

interface AzcoCollectionAccess {
  collectionName: string;
  members: AzcoAccessEntry[];
}

function azcoPermissionLabel(sel: {
  readOnly?: boolean;
  hidePasswords?: boolean;
  manage?: boolean;
}): string {
  if (sel.manage) {
    return "Manage";
  }
  if (sel.readOnly) {
    return sel.hidePasswords ? "View (hidden)" : "View";
  }
  return sel.hidePasswords ? "Edit (hidden)" : "Edit";
}
