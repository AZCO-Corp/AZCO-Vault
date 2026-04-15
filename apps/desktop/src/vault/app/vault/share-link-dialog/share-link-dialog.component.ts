import { CommonModule } from "@angular/common";
import { Component } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from "@angular/forms";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import {
  ButtonModule,
  DialogModule,
  DialogRef,
  DialogService,
  FormFieldModule,
  InputModule,
  RadioButtonModule,
  SwitchComponent,
} from "@bitwarden/components";

export type ShareLinkAudience = "public" | "emails";

export type ShareLinkDialogResult = {
  hours: number;
  audience: ShareLinkAudience;
  emails: string[];
  viewOnce: boolean;
};

type ShareLinkForm = FormGroup<{
  hours: FormControl<number>;
  audience: FormControl<ShareLinkAudience>;
  emailsText: FormControl<string>;
  viewOnce: FormControl<boolean>;
}>;

// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "azco-share-link-dialog",
  templateUrl: "share-link-dialog.component.html",
  imports: [
    ButtonModule,
    CommonModule,
    DialogModule,
    FormFieldModule,
    InputModule,
    JslibModule,
    RadioButtonModule,
    ReactiveFormsModule,
    SwitchComponent,
  ],
})
export class ShareLinkDialogComponent {
  readonly hourPresets: { label: string; hours: number }[] = [
    { label: "1 hour", hours: 1 },
    { label: "1 day", hours: 24 },
    { label: "7 days", hours: 24 * 7 },
    { label: "14 days", hours: 24 * 14 },
    { label: "30 days", hours: 24 * 30 },
  ];

  form: ShareLinkForm = new FormGroup({
    hours: new FormControl<number>(24 * 7, { nonNullable: true, validators: Validators.required }),
    audience: new FormControl<ShareLinkAudience>("public", {
      nonNullable: true,
      validators: Validators.required,
    }),
    emailsText: new FormControl<string>("", { nonNullable: true }),
    viewOnce: new FormControl<boolean>(false, { nonNullable: true }),
  });

  constructor(private dialogRef: DialogRef<ShareLinkDialogResult>) {}

  get audienceValue(): ShareLinkAudience {
    return this.form.controls.audience.value;
  }

  submit = () => {
    const v = this.form.getRawValue();
    const emails =
      v.audience === "emails"
        ? v.emailsText
            .split(/[\s,;]+/)
            .map((e) => e.trim())
            .filter((e) => e.length > 0 && e.includes("@"))
        : [];

    const result: ShareLinkDialogResult = {
      hours: v.hours,
      audience: v.audience,
      emails,
      viewOnce: v.viewOnce,
    };
    this.dialogRef.close(result);
  };

  cancel = () => {
    this.dialogRef.close(undefined);
  };

  static open(dialogService: DialogService) {
    return dialogService.open<ShareLinkDialogResult | undefined>(ShareLinkDialogComponent);
  }
}
