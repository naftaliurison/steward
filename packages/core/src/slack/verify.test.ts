import { describe, expect, it } from "vitest";
import { slackSignature, verifySlackSignature } from "./verify";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const timestamp = "1531420618";
const body =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";

describe("slackSignature", () => {
  it("matches the worked example from Slack's 'Verifying requests' documentation", async () => {
    // If this vector ever fails, check the documentation page, not the implementation.
    expect(await slackSignature(secret, timestamp, body)).toBe(
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    );
  });
});

describe("verifySlackSignature", () => {
  const now = Number(timestamp) + 10;

  it("accepts a correct signature within the five-minute window", async () => {
    const signature = await slackSignature(secret, timestamp, body);
    expect(
      await verifySlackSignature({ secret, timestamp, body, signature, nowSeconds: now }),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await slackSignature(secret, timestamp, body);
    expect(
      await verifySlackSignature({
        secret,
        timestamp,
        body: `${body}&x=1`,
        signature,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const signature = await slackSignature(secret, timestamp, body);
    expect(
      await verifySlackSignature({ secret, timestamp, body, signature, nowSeconds: now + 600 }),
    ).toBe(false);
  });

  it("rejects a malformed timestamp and a wrong-length signature", async () => {
    expect(
      await verifySlackSignature({
        secret,
        timestamp: "abc",
        body,
        signature: "v0=00",
        nowSeconds: now,
      }),
    ).toBe(false);
    expect(
      await verifySlackSignature({ secret, timestamp, body, signature: "v0=00", nowSeconds: now }),
    ).toBe(false);
  });
});
