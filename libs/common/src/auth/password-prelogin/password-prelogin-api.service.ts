import { ApiService } from "../../abstractions/api.service";
import { EnvironmentService } from "../../platform/abstractions/environment.service";

import { PasswordPreloginRequest } from "./password-prelogin.request";
import { PasswordPreloginResponse } from "./password-prelogin.response";

export class PasswordPreloginApiService {
  constructor(
    private apiService: ApiService,
    private environmentService: EnvironmentService,
  ) {}

  // AZCO vaultwarden-compat: upstream moved this to POST /identity/accounts/prelogin/password
  // in 2026.4; Vaultwarden still serves only the classic POST /api/accounts/prelogin with an
  // identical request/response shape. Route to the classic endpoint.
  async getPreloginData(request: PasswordPreloginRequest): Promise<PasswordPreloginResponse> {
    const r = await this.apiService.send("POST", "/accounts/prelogin", request, false, true);
    return new PasswordPreloginResponse(r);
  }
}
