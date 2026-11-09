// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Product, REPO_URL } from "./Product";

afterEach(cleanup);

describe("Product page", () => {
  it("names the product, links to the demo and the code, and says it is not Slack", () => {
    render(<Product />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Steward Availability");
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe("/try");
    expect(screen.getByRole("link", { name: "Read the code" }).getAttribute("href")).toBe(REPO_URL);
    expect(screen.getByText(/Steward is not affiliated with Slack\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What works today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Coming next" })).toBeTruthy();
  });

  it("says how long the demo keeps what you enter", () => {
    render(<Product />);
    expect(screen.getByText(/kept on this site for up to an hour, then deleted/)).toBeTruthy();
  });

  it("says Steward must be connected to your Slack account before Save sets a status", () => {
    render(<Product />);
    expect(screen.getByText(/^Once you have connected Steward/)).toBeTruthy();
  });

  it("offers no install yet", () => {
    render(<Product />);
    expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
  });
});
