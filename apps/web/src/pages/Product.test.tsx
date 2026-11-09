// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Product, ProductPage, REPO_URL } from "./Product";

afterEach(cleanup);

describe("Product page", () => {
  it("names the product, links to the demo and the code, and says it is not Slack", () => {
    render(<Product installable={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Steward Availability");
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe("/try");
    expect(screen.getByRole("link", { name: "Read the code" }).getAttribute("href")).toBe(REPO_URL);
    expect(screen.getByText(/Steward is not affiliated with Slack\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What works today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Coming next" })).toBeTruthy();
  });

  it("offers Add to Slack only when the install flow is configured", () => {
    render(<Product installable={false} />);
    expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
    cleanup();
    render(<Product installable />);
    expect(screen.getByRole("link", { name: "Add to Slack" }).getAttribute("href")).toBe(
      "/oauth/slack/install",
    );
  });
});

describe("ProductPage", () => {
  it("shows Add to Slack once /health says install is configured", async () => {
    render(<ProductPage health={async () => ({ slack: true })} />);
    expect(await screen.findByRole("link", { name: "Add to Slack" })).toBeTruthy();
  });

  it("stays without it when /health cannot be read", async () => {
    render(<ProductPage health={() => Promise.reject(new Error("offline"))} />);
    expect(await screen.findByRole("link", { name: "Try the demo" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
  });
});
