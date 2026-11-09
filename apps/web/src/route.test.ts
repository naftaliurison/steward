import { describe, expect, it } from "vitest";
import { pageFor } from "./route";

describe("pageFor", () => {
  it("sends /try to the emulator and everything else to the product page", () => {
    expect(pageFor("/try")).toBe("try");
    expect(pageFor("/try/")).toBe("try");
    expect(pageFor("/")).toBe("product");
    expect(pageFor("/anything-else")).toBe("product");
    expect(pageFor("/trying")).toBe("product");
  });
});
