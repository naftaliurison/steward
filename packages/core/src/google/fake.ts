import {
  GoogleApiError,
  type GoogleAppCredentials,
  type GoogleCalendarEntry,
  type GoogleClient,
  type GoogleEventInput,
  type GoogleTokens,
  type VacationSettings,
} from "./client";

const OFF: VacationSettings = {
  enableAutoReply: false,
  responseSubject: "",
  responseBodyPlainText: "",
  startTime: null,
  endTime: null,
  restrictToContacts: false,
  restrictToDomain: false,
};

/** In-memory Google: one account's calendars, events and auto-reply, with every call recorded. */
export class FakeGoogleClient implements GoogleClient {
  /** What `exchangeCode` answers. Set `refreshToken` to null to act like a consent that gave no refresh token. */
  tokens: GoogleTokens = {
    accessToken: "ya29.access",
    expiresInSeconds: 3600,
    refreshToken: "1//refresh",
    scope: "",
    idToken: null,
  };
  calendars: GoogleCalendarEntry[] = [{ id: "dana@example.com", summary: "Dana", primary: true }];
  /** Keyed `<calendarId>/<eventId>`. */
  events = new Map<string, GoogleEventInput>();
  vacation: VacationSettings = { ...OFF };
  /** True makes every `outOfOffice` insert answer 400, like an account type that does not have them. */
  rejectOutOfOffice = false;
  exchangedCodes: string[] = [];
  refreshes: string[] = [];
  revoked: string[] = [];
  inserts: { calendarId: string; event: GoogleEventInput }[] = [];
  /** Set a method name to make its next call fail once with that status and reason. */
  failNext: Partial<Record<keyof GoogleClient, { status: number; code: string }>> = {};

  private maybeFail(method: keyof GoogleClient): void {
    const failure = this.failNext[method];
    if (failure) {
      delete this.failNext[method];
      throw new GoogleApiError(method, failure.status, failure.code);
    }
  }

  async exchangeCode(
    args: GoogleAppCredentials & { code: string; redirectUri: string },
  ): Promise<GoogleTokens> {
    this.maybeFail("exchangeCode");
    this.exchangedCodes.push(args.code);
    return this.tokens;
  }

  async refreshAccessToken(
    args: GoogleAppCredentials & { refreshToken: string },
  ): Promise<{ accessToken: string; expiresInSeconds: number }> {
    this.maybeFail("refreshAccessToken");
    this.refreshes.push(args.refreshToken);
    return { accessToken: "ya29.fresh", expiresInSeconds: 3600 };
  }

  async revokeToken(args: { token: string }): Promise<void> {
    this.maybeFail("revokeToken");
    this.revoked.push(args.token);
  }

  async listCalendars(_args: { accessToken: string }): Promise<GoogleCalendarEntry[]> {
    this.maybeFail("listCalendars");
    return this.calendars;
  }

  async insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventInput;
  }): Promise<{ id: string }> {
    this.maybeFail("insertEvent");
    // Google takes an event id only in base32hex: 0-9 and a-v, five to 1024 characters.
    if (!/^[0-9a-v]{5,1024}$/.test(args.event.id)) {
      throw new GoogleApiError("insertEvent", 400, "invalid");
    }
    if (this.rejectOutOfOffice && args.event.eventType === "outOfOffice") {
      throw new GoogleApiError("insertEvent", 400, "invalid");
    }
    const key = `${args.calendarId}/${args.event.id}`;
    if (this.events.has(key)) throw new GoogleApiError("insertEvent", 409, "duplicate");
    this.events.set(key, args.event);
    this.inserts.push({ calendarId: args.calendarId, event: args.event });
    return { id: args.event.id };
  }

  async deleteEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    this.maybeFail("deleteEvent");
    this.events.delete(`${args.calendarId}/${args.eventId}`);
  }

  async getVacation(_args: { accessToken: string }): Promise<VacationSettings> {
    this.maybeFail("getVacation");
    return { ...this.vacation };
  }

  async setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void> {
    this.maybeFail("setVacation");
    this.vacation = { ...args.settings };
  }
}
