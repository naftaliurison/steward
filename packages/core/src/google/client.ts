export type GoogleTokens = {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  /** Granted scopes, separated by spaces. */
  scope: string;
  idToken: string | null;
};

export type GoogleCalendarEntry = { id: string; summary: string; primary: boolean };

export type GoogleEventTime = { dateTime: string } | { date: string };

export type GoogleEventInput = {
  /** Chosen by the caller: characters a–v and 0–9, 5 to 1024 long. A second insert with the same id answers 409. */
  id: string;
  summary: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  transparency: "opaque";
  eventType?: "outOfOffice";
  outOfOfficeProperties?: { autoDeclineMode: string; declineMessage: string };
};

/** Times are epoch milliseconds; null means not set. */
export type VacationSettings = {
  enableAutoReply: boolean;
  responseSubject: string;
  responseBodyPlainText: string;
  startTime: number | null;
  endTime: number | null;
  /** Who gets the reply: the person's own setting, kept as it is when Steward writes. */
  restrictToContacts: boolean;
  restrictToDomain: boolean;
};

export type GoogleAppCredentials = { clientId: string; clientSecret: string };

export interface GoogleClient {
  exchangeCode(
    args: GoogleAppCredentials & { code: string; redirectUri: string },
  ): Promise<GoogleTokens>;
  refreshAccessToken(
    args: GoogleAppCredentials & { refreshToken: string },
  ): Promise<{ accessToken: string; expiresInSeconds: number }>;
  /** Takes Steward's access away at Google. A token that is already revoked is not an error. */
  revokeToken(args: { token: string }): Promise<void>;
  /** The calendars the person can write to. */
  listCalendars(args: { accessToken: string }): Promise<GoogleCalendarEntry[]>;
  insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventInput;
  }): Promise<{ id: string }>;
  /** An event that is already gone is not an error. */
  deleteEvent(args: { accessToken: string; calendarId: string; eventId: string }): Promise<void>;
  getVacation(args: { accessToken: string }): Promise<VacationSettings>;
  setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void>;
}

/** `status` is the HTTP status; `code` is Google's own reason when it gave one, else `http_<status>`. */
export class GoogleApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
    this.name = "GoogleApiError";
  }
}

/** Every call to Google gives up after this long. */
export const GOOGLE_TIMEOUT_MS = 8000;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3";
const VACATION_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

type ErrorBody = {
  error?: string | { status?: string; errors?: { reason?: string }[] };
};
type TokenBody = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
};
type VacationBody = {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  startTime?: string;
  endTime?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
};

/** The token endpoint says `{ error: "invalid_grant" }`; the APIs say `{ error: { errors: [{ reason }] } }`. */
async function reasonOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body.error === "string") return body.error;
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? `http_${res.status}`;
  } catch {
    return `http_${res.status}`;
  }
}

const time = (value: string | undefined): number | null => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : null;
};

/** The email claim of an ID token that came straight from Google's token endpoint over TLS (so it is not verified again here). */
export function emailFromIdToken(idToken: string | null): string | null {
  const part = idToken?.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as {
      email?: unknown;
    };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export class RealGoogleClient implements GoogleClient {
  // The default is a wrapper, not `fetch` itself: Workers rejects the platform fetch when it is
  // called as a method of another object, which `this.fetchFn(...)` would be.
  constructor(private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}

  /** Sends one request; any status outside 2xx and `alsoFine` becomes a GoogleApiError. */
  private async send(
    method: string,
    url: string,
    init: RequestInit,
    alsoFine: number[] = [],
  ): Promise<Response> {
    const res = await this.fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok && !alsoFine.includes(res.status)) {
      throw new GoogleApiError(method, res.status, await reasonOf(res));
    }
    return res;
  }

  private async body<T>(method: string, res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new GoogleApiError(method, res.status, `http_${res.status}`);
    }
  }

  private async token(method: string, form: Record<string, string>): Promise<TokenBody> {
    const res = await this.send(method, TOKEN_URL, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams(form).toString(),
    });
    const data = await this.body<TokenBody>(method, res);
    if (!data.access_token) throw new GoogleApiError(method, res.status, "no_access_token");
    return data;
  }

  private api(accessToken: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown) {
    return {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  async exchangeCode(
    args: GoogleAppCredentials & { code: string; redirectUri: string },
  ): Promise<GoogleTokens> {
    const data = await this.token("token.exchange", {
      grant_type: "authorization_code",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    });
    return {
      accessToken: data.access_token ?? "",
      expiresInSeconds: data.expires_in ?? 0,
      refreshToken: data.refresh_token ?? null,
      scope: data.scope ?? "",
      idToken: data.id_token ?? null,
    };
  }

  async refreshAccessToken(
    args: GoogleAppCredentials & { refreshToken: string },
  ): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const data = await this.token("token.refresh", {
      grant_type: "refresh_token",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
    });
    return { accessToken: data.access_token ?? "", expiresInSeconds: data.expires_in ?? 0 };
  }

  async revokeToken(args: { token: string }): Promise<void> {
    await this.send(
      "token.revoke",
      REVOKE_URL,
      {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ token: args.token }).toString(),
      },
      [400],
    );
  }

  async listCalendars(args: { accessToken: string }): Promise<GoogleCalendarEntry[]> {
    const method = "calendarList.list";
    const res = await this.send(
      method,
      `${CALENDAR_URL}/users/me/calendarList?minAccessRole=writer&maxResults=250`,
      this.api(args.accessToken, "GET"),
    );
    const data = await this.body<{
      items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[];
    }>(method, res);
    return (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summaryOverride ?? item.summary ?? item.id,
      primary: item.primary === true,
    }));
  }

  async insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventInput;
  }): Promise<{ id: string }> {
    const method = "events.insert";
    const res = await this.send(
      method,
      `${CALENDAR_URL}/calendars/${encodeURIComponent(args.calendarId)}/events`,
      this.api(args.accessToken, "POST", args.event),
    );
    const data = await this.body<{ id?: string }>(method, res);
    return { id: data.id ?? args.event.id };
  }

  async deleteEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    await this.send(
      "events.delete",
      `${CALENDAR_URL}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
      this.api(args.accessToken, "DELETE"),
      [404, 410],
    );
  }

  async getVacation(args: { accessToken: string }): Promise<VacationSettings> {
    const method = "vacation.get";
    const res = await this.send(method, VACATION_URL, this.api(args.accessToken, "GET"));
    const data = await this.body<VacationBody>(method, res);
    return {
      enableAutoReply: data.enableAutoReply === true,
      responseSubject: data.responseSubject ?? "",
      responseBodyPlainText: data.responseBodyPlainText ?? "",
      startTime: time(data.startTime),
      endTime: time(data.endTime),
      restrictToContacts: data.restrictToContacts === true,
      restrictToDomain: data.restrictToDomain === true,
    };
  }

  async setVacation(args: { accessToken: string; settings: VacationSettings }): Promise<void> {
    const s = args.settings;
    await this.send(
      "vacation.update",
      VACATION_URL,
      this.api(args.accessToken, "PUT", {
        enableAutoReply: s.enableAutoReply,
        responseSubject: s.responseSubject,
        responseBodyPlainText: s.responseBodyPlainText,
        restrictToContacts: s.restrictToContacts,
        restrictToDomain: s.restrictToDomain,
        ...(s.startTime === null ? {} : { startTime: String(s.startTime) }),
        ...(s.endTime === null ? {} : { endTime: String(s.endTime) }),
      }),
    );
  }
}
