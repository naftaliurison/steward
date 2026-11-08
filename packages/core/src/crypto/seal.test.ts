import { describe, expect, it } from "vitest";
import { newKeyB64, open, seal } from "./seal";

describe("seal/open", () => {
  it("round-trips a token and never stores it in clear", async () => {
    const key = newKeyB64();
    const sealed = await seal(key, "xoxb-secret-token");
    expect(sealed).not.toContain("xoxb");
    expect(await open(key, sealed)).toBe("xoxb-secret-token");
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const key = newKeyB64();
    expect(await seal(key, "same")).not.toBe(await seal(key, "same"));
  });

  it("fails to open with another key", async () => {
    const sealed = await seal(newKeyB64(), "secret");
    await expect(open(newKeyB64(), sealed)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(seal(btoa("short"), "x")).rejects.toThrow(/32 bytes/);
  });
});
