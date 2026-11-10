import { GMAIL_RESPONDER, GOOGLE_CALENDAR } from "@steward/availability";
import { describe, expect, it } from "vitest";
import { googleConfigured, registryFor } from "../src/registry";
import { testDeps } from "./helpers";

describe("registryFor", () => {
  it("has Slack and both Google connectors when the OAuth client is set", () => {
    const registry = registryFor(testDeps());
    expect(registry.get("slack-status")).toBeDefined();
    expect(registry.get(GOOGLE_CALENDAR)).toBeDefined();
    expect(registry.get(GMAIL_RESPONDER)).toBeDefined();
  });

  it("has only Slack when either id is missing", () => {
    for (const deps of [
      testDeps({ googleClientId: null }),
      testDeps({ googleClientSecret: null }),
    ]) {
      const registry = registryFor(deps);
      expect(registry.get("slack-status")).toBeDefined();
      expect(registry.get(GOOGLE_CALENDAR)).toBeUndefined();
      expect(registry.get(GMAIL_RESPONDER)).toBeUndefined();
    }
  });

  it("googleConfigured is true only when both are set", () => {
    expect(googleConfigured({ googleClientId: "a", googleClientSecret: "b" })).toBe(true);
    expect(googleConfigured({ googleClientId: null, googleClientSecret: "b" })).toBe(false);
    expect(googleConfigured({ googleClientId: "a", googleClientSecret: null })).toBe(false);
  });
});
