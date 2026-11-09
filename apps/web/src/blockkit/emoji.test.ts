import { describe, expect, it } from "vitest";
import { emojify } from "./emoji";

describe("emojify", () => {
  it("replaces the product's shortcodes", () => {
    expect(emojify(":palm_tree: :house:")).toBe("🌴 🏠");
  });

  it("leaves inherited property names as typed", () => {
    const text = ":constructor: :toString: :__proto__:";
    expect(emojify(text)).toBe(text);
  });
});
