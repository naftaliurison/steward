// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Product } from "./Product";

afterEach(cleanup);

describe("Product page", () => {
  it("names the product and links to the demo", () => {
    render(<Product />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Steward");
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe("/try");
  });
});
