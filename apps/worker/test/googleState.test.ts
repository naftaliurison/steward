import { slackSignature } from "@steward/core";
import { describe, expect, it } from "vitest";
import { signGoogleState, verifyGoogleState } from "../src/google/state";
import { signState, verifyState } from "../src/routes/oauth";
import { SIGNING_SECRET } from "./helpers";

const NOW = 1_800_000_000;
const PERSON = "T1:U.1";

describe("Google state", () => {
  it("round-trips the person id, even one with a colon and a dot", async () => {
    const state = await signGoogleState(SIGNING_SECRET, PERSON, NOW);
    expect(await verifyGoogleState(SIGNING_SECRET, state, NOW)).toBe(PERSON);
  });

  it("accepts a ticket 600 seconds old and rejects 601", async () => {
    const state = await signGoogleState(SIGNING_SECRET, PERSON, NOW);
    expect(await verifyGoogleState(SIGNING_SECRET, state, NOW + 600)).toBe(PERSON);
    expect(await verifyGoogleState(SIGNING_SECRET, state, NOW + 601)).toBeNull();
  });

  it("accepts 60 seconds in the future and rejects 61", async () => {
    const state = await signGoogleState(SIGNING_SECRET, PERSON, NOW + 60);
    expect(await verifyGoogleState(SIGNING_SECRET, state, NOW)).toBe(PERSON);
    const later = await signGoogleState(SIGNING_SECRET, PERSON, NOW + 61);
    expect(await verifyGoogleState(SIGNING_SECRET, later, NOW)).toBeNull();
  });

  it("rejects a changed person id, time or signature", async () => {
    const [ts, who, mac] = (await signGoogleState(SIGNING_SECRET, PERSON, NOW)).split(".") as [
      string,
      string,
      string,
    ];
    const otherWho = btoa("T1:U2").replace(/=+$/, "");
    expect(await verifyGoogleState(SIGNING_SECRET, `${ts}.${otherWho}.${mac}`, NOW)).toBeNull();
    expect(
      await verifyGoogleState(SIGNING_SECRET, `${Number(ts) + 1}.${who}.${mac}`, NOW + 1),
    ).toBeNull();
    const flipped = (mac.startsWith("0") ? "1" : "0") + mac.slice(1);
    expect(await verifyGoogleState(SIGNING_SECRET, `${ts}.${who}.${flipped}`, NOW)).toBeNull();
    expect(await verifyGoogleState("another-secret", `${ts}.${who}.${mac}`, NOW)).toBeNull();
  });

  it("rejects a Slack install state", async () => {
    const slack = await signState(SIGNING_SECRET, NOW);
    expect(await verifyGoogleState(SIGNING_SECRET, slack, NOW)).toBeNull();
    expect(await verifyGoogleState(SIGNING_SECRET, `${slack}.x`, NOW)).toBeNull();
  });

  it("rejects a three-part state signed without the google: prefix", async () => {
    const who = btoa(PERSON).replace(/=+$/, "");
    const ts = String(NOW);
    // What the Slack install flow signs: over its own text "install".
    const slackMac = (await slackSignature(SIGNING_SECRET, ts, "install")).slice(3);
    expect(await verifyGoogleState(SIGNING_SECRET, `${ts}.${who}.${slackMac}`, NOW)).toBeNull();
    // The same text as Google's, minus the prefix.
    const bareMac = (await slackSignature(SIGNING_SECRET, ts, `${ts}:${PERSON}`)).slice(3);
    expect(await verifyGoogleState(SIGNING_SECRET, `${ts}.${who}.${bareMac}`, NOW)).toBeNull();
  });

  it("is not accepted by the Slack install check", async () => {
    const google = await signGoogleState(SIGNING_SECRET, PERSON, NOW);
    expect(await verifyState(SIGNING_SECRET, google, NOW)).toBe(false);
  });

  it("returns null for garbage without throwing", async () => {
    for (const bad of ["", "a.b", "x.y.z", "1.%%%.abc", `${NOW}.!!.00`, "a.b.c.d"]) {
      expect(await verifyGoogleState(SIGNING_SECRET, bad, NOW)).toBeNull();
    }
  });
});
