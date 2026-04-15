import { CommonModule } from "@angular/common";
import {
  Input,
  Output,
  EventEmitter,
  Component,
  OnInit,
  ViewChild,
  OnChanges,
  SimpleChanges,
  input,
} from "@angular/core";
import { firstValueFrom, switchMap } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SendTextView } from "@bitwarden/common/tools/send/models/view/send-text.view";
import { SendView } from "@bitwarden/common/tools/send/models/view/send.view";
import { SendApiService } from "@bitwarden/common/tools/send/services/send-api.service.abstraction";
import { SendService } from "@bitwarden/common/tools/send/services/send.service.abstraction";
import { SendType } from "@bitwarden/common/tools/send/types/send-type";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherArchiveService } from "@bitwarden/common/vault/abstractions/cipher-archive.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherRepromptType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { CipherAuthorizationService } from "@bitwarden/common/vault/services/cipher-authorization.service";
import { ButtonComponent, ButtonModule, DialogService, ToastService } from "@bitwarden/components";
import { ArchiveCipherUtilitiesService, PasswordRepromptService } from "@bitwarden/vault";

import {
  ShareLinkDialogComponent,
  ShareLinkDialogResult,
} from "./share-link-dialog/share-link-dialog.component";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-vault-item-footer",
  templateUrl: "item-footer.component.html",
  imports: [ButtonModule, CommonModule, JslibModule],
})
export class ItemFooterComponent implements OnInit, OnChanges {
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input({ required: true }) cipher: CipherView = new CipherView();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input() collectionId: string | null = null;
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input({ required: true }) action: string = "view";
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @Input() masterPasswordAlreadyPrompted: boolean = false;
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onEdit = new EventEmitter<CipherView>();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onClone = new EventEmitter<CipherView>();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onDelete = new EventEmitter<CipherView>();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onRestore = new EventEmitter<CipherView>();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onCancel = new EventEmitter<CipherView>();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-output-emitter-ref
  @Output() onArchiveToggle = new EventEmitter<CipherView>();
  // FIXME(https://bitwarden.atlassian.net/browse/CL-903): Migrate to Signals
  // eslint-disable-next-line @angular-eslint/prefer-signals
  @ViewChild("submitBtn", { static: false }) submitBtn: ButtonComponent | null = null;

  readonly submitButtonText = input<string>(this.i18nService.t("save"));

  activeUserId: UserId | null = null;
  passwordReprompted: boolean = false;

  protected showArchiveButton = false;
  protected showUnarchiveButton = false;
  protected userCanArchive = false;

  constructor(
    protected cipherService: CipherService,
    protected dialogService: DialogService,
    protected passwordRepromptService: PasswordRepromptService,
    protected cipherAuthorizationService: CipherAuthorizationService,
    protected accountService: AccountService,
    protected toastService: ToastService,
    protected i18nService: I18nService,
    protected logService: LogService,
    protected cipherArchiveService: CipherArchiveService,
    protected archiveCipherUtilitiesService: ArchiveCipherUtilitiesService,
    protected sendService: SendService,
    protected sendApiService: SendApiService,
    protected environmentService: EnvironmentService,
    protected platformUtilsService: PlatformUtilsService,
  ) {}

  async ngOnInit() {
    this.activeUserId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
    this.passwordReprompted = this.masterPasswordAlreadyPrompted;
    await this.checkArchiveState();
  }

  async ngOnChanges(changes: SimpleChanges) {
    if (changes.cipher || changes.action) {
      await this.checkArchiveState();
    }
  }

  async clone() {
    if (this.cipher.login?.hasFido2Credentials) {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "passkeyNotCopied" },
        content: { key: "passkeyNotCopiedAlert" },
        type: "info",
      });

      if (!confirmed) {
        return false;
      }
    }

    if (await this.promptPassword()) {
      this.onClone.emit(this.cipher);
      return true;
    }

    return false;
  }

  protected edit() {
    this.onEdit.emit(this.cipher);
  }

  // AZCO: share current cipher as a time-limited Bitwarden Send link.
  // Opens a config dialog (expiration, audience, view-once) then creates the Send.
  async shareLink(): Promise<void> {
    if (!(await this.promptPassword())) {
      return;
    }

    const dialogRef = ShareLinkDialogComponent.open(this.dialogService);
    const config = (await firstValueFrom(dialogRef.closed)) as ShareLinkDialogResult | undefined;
    if (!config) {
      return;
    }

    try {
      const c = this.cipher;
      const allowedHeader =
        config.audience === "emails" && config.emails.length > 0
          ? `Allowed recipients (UI hint only): ${config.emails.join(", ")}\n\n`
          : "";
      const body = allowedHeader + this.buildShareBody(c);

      const expiresAt = new Date(Date.now() + config.hours * 60 * 60 * 1000);
      const send = new SendView();
      send.name = `AZCO Share: ${c.name ?? "Item"}`;
      send.type = SendType.Text;
      send.text = new SendTextView();
      send.text.text = body;
      send.text.hidden = false;
      send.deletionDate = expiresAt;
      send.expirationDate = expiresAt;
      send.maxAccessCount = config.viewOnce ? 1 : (null as any);
      send.password = null as any;

      const sendData = await this.sendService.encrypt(send, null as any, null as any, null);
      const saved = await this.sendApiService.save(sendData);

      const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      const decrypted = await saved.decrypt(userId);

      const env = await firstValueFrom(this.environmentService.environment$);
      const link = env.getSendUrl() + decrypted.accessId + "/" + decrypted.urlB64Key;
      this.platformUtilsService.copyToClipboard(link);

      const expiryLabel = this.formatExpiryLabel(config.hours);
      const viewLabel = config.viewOnce ? ", max 1 view" : "";
      const audienceWarning =
        config.audience === "emails"
          ? " (email restriction is UI-only for now — link is still accessible to anyone who has it)"
          : "";
      this.toastService.showToast({
        variant: "success",
        title: null,
        message: `Share link copied — expires in ${expiryLabel}${viewLabel}.${audienceWarning}`,
      });
    } catch (e) {
      this.logService.error(e);
      this.toastService.showToast({
        variant: "error",
        title: null,
        message: `Share failed: ${(e as Error)?.message ?? "unknown"}`,
      });
    }
  }

  // AZCO: format an arbitrary cipher (login/card/identity/securenote/sshkey) as shareable text.
  private buildShareBody(c: CipherView): string {
    const rows: { label: string; value: string | undefined | null }[] = [];
    rows.push({ label: "Name", value: c.name });

    switch (c.type) {
      case CipherType.Login:
        rows.push(
          { label: "URL", value: c.login?.uris?.[0]?.uri },
          { label: "Username", value: c.login?.username },
          { label: "Password", value: c.login?.password },
          { label: "TOTP", value: c.login?.totp },
        );
        break;
      case CipherType.Card: {
        const exp =
          c.card?.expMonth && c.card?.expYear ? `${c.card.expMonth}/${c.card.expYear}` : undefined;
        rows.push(
          { label: "Cardholder", value: c.card?.cardholderName },
          { label: "Brand", value: c.card?.brand },
          { label: "Number", value: c.card?.number },
          { label: "Expires", value: exp },
          { label: "CVV", value: c.card?.code },
        );
        break;
      }
      case CipherType.Identity: {
        const id = c.identity;
        const fullName =
          [id?.firstName, id?.middleName, id?.lastName].filter((x) => !!x).join(" ") || undefined;
        const address =
          [id?.address1, id?.address2, id?.city, id?.state, id?.postalCode, id?.country]
            .filter((x) => !!x)
            .join(", ") || undefined;
        rows.push(
          { label: "Name", value: fullName },
          { label: "Username", value: id?.username },
          { label: "Email", value: id?.email },
          { label: "Phone", value: id?.phone },
          { label: "Company", value: id?.company },
          { label: "SSN", value: id?.ssn },
          { label: "Passport", value: id?.passportNumber },
          { label: "License", value: id?.licenseNumber },
          { label: "Address", value: address },
        );
        break;
      }
      case CipherType.SshKey: {
        const k = (c as any).sshKey;
        rows.push(
          { label: "Public Key", value: k?.publicKey },
          { label: "Private Key", value: k?.privateKey },
          { label: "Fingerprint", value: k?.keyFingerprint },
        );
        break;
      }
      // SecureNote and anything else: just name + notes.
    }

    const lines = rows
      .filter((r) => r.value !== undefined && r.value !== null && r.value !== "")
      .map((r) => `${r.label}: ${r.value}`);

    if (c.notes) {
      lines.push("", "Notes:", c.notes);
    }
    return lines.join("\n");
  }

  private formatExpiryLabel(hours: number): string {
    if (hours < 24) {
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  protected get hasFooterAction() {
    return this.showArchiveButton || this.showUnarchiveButton || this.canDelete;
  }

  protected get showCloneOption() {
    return (
      this.cipher.id &&
      !this.cipher?.organizationId &&
      !this.cipher.isDeleted &&
      this.action === "view" &&
      (!this.cipher.isArchived || this.userCanArchive)
    );
  }

  protected get canDelete() {
    return this.cipher.permissions?.delete && (this.action === "edit" || this.action === "view");
  }

  cancel() {
    this.onCancel.emit(this.cipher);
  }

  async delete(): Promise<boolean> {
    if (!(await this.promptPassword())) {
      return false;
    }

    const confirmed = await this.dialogService.openSimpleDialog({
      title: { key: "deleteItem" },
      content: {
        key: this.cipher.isDeleted ? "permanentlyDeleteItemConfirmation" : "deleteItemConfirmation",
      },
      type: "warning",
    });

    if (!confirmed) {
      return false;
    }

    try {
      const activeUserId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      await this.deleteCipher(activeUserId);
      this.toastService.showToast({
        variant: "success",
        message: this.i18nService.t(
          this.cipher.isDeleted ? "permanentlyDeletedItem" : "deletedItem",
        ),
      });
      this.onDelete.emit(this.cipher);
    } catch (e) {
      this.logService.error(e);
    }

    return true;
  }

  async restore(): Promise<boolean> {
    let toastMessage;
    if (!this.cipher.isDeleted) {
      return false;
    }

    if (this.cipher.isArchived) {
      toastMessage = this.i18nService.t("archivedItemRestored");
    } else {
      toastMessage = this.i18nService.t("restoredItem");
    }

    try {
      const activeUserId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
      await this.restoreCipher(activeUserId);
      this.toastService.showToast({
        variant: "success",
        message: toastMessage,
      });
      this.onRestore.emit(this.cipher);
    } catch (e) {
      this.logService.error(e);
    }

    return true;
  }

  protected deleteCipher(userId: UserId) {
    return this.cipher.isDeleted
      ? this.cipherService.deleteWithServer(this.cipher.id, userId)
      : this.cipherService.softDeleteWithServer(this.cipher.id, userId);
  }

  protected restoreCipher(userId: UserId) {
    return this.cipherService.restoreWithServer(this.cipher.id, userId);
  }

  protected async promptPassword() {
    if (this.cipher.reprompt === CipherRepromptType.None || this.passwordReprompted) {
      return true;
    }

    return (this.passwordReprompted = await this.passwordRepromptService.showPasswordPrompt());
  }

  protected async archive() {
    /**
     * When the Archive Button is used in the footer we can skip the reprompt since
     * the user will have already passed the reprompt when they opened the item.
     */
    await this.archiveCipherUtilitiesService.archiveCipher(this.cipher, true);
    this.onArchiveToggle.emit();
  }

  protected async unarchive() {
    /**
     * When the Unarchive Button is used in the footer we can skip the reprompt since
     * the user will have already passed the reprompt when they opened the item.
     */
    await this.archiveCipherUtilitiesService.unarchiveCipher(this.cipher, true);
    this.onArchiveToggle.emit();
  }

  private async checkArchiveState() {
    const cipherCanBeArchived = !this.cipher.isDeleted;
    const userCanArchive = await firstValueFrom(
      this.accountService.activeAccount$.pipe(
        getUserId,
        switchMap((id) => this.cipherArchiveService.userCanArchive$(id)),
      ),
    );

    this.userCanArchive = userCanArchive;

    this.showArchiveButton =
      cipherCanBeArchived && userCanArchive && this.action === "view" && !this.cipher.isArchived;

    // A user should always be able to unarchive an archived item
    this.showUnarchiveButton =
      this.action === "view" && this.cipher.isArchived && !this.cipher.isDeleted;
  }
}
