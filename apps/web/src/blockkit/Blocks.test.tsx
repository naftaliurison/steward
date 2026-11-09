// @vitest-environment jsdom
import {
  actions,
  type Block,
  button,
  context,
  divider,
  header,
  section,
} from "@steward/core/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Blocks } from "./Blocks";

afterEach(cleanup);

const receipt: Block[] = [
  header("Out of office · Thu 12 Nov"),
  section("✅ Slack status set — clears Thu 12 Nov"),
  actions(button("Undo", "status_undo", { value: "st_1", style: "danger" })),
  context("You can undo until 10:05."),
];

describe("Blocks", () => {
  it("renders a receipt and reports the button that was pressed", () => {
    const onAction = vi.fn();
    render(<Blocks blocks={receipt} onAction={onAction} />);
    expect(screen.getByRole("heading", { name: "Out of office · Thu 12 Nov" })).toBeTruthy();
    expect(screen.getByText("✅ Slack status set — clears Thu 12 Nov")).toBeTruthy();
    expect(screen.getByText("You can undo until 10:05.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledWith({ action_id: "status_undo", value: "st_1" });
  });

  it("disables buttons while a request is in flight", () => {
    render(<Blocks blocks={receipt} disabled />);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders section fields, a divider and a link button", () => {
    const blocks: Block[] = [
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*From*" },
          { type: "plain_text", text: "Thu" },
        ],
      },
      divider(),
      actions(button("Docs", "docs", { url: "https://example.com/docs" })),
    ];
    const { container } = render(<Blocks blocks={blocks} />);
    expect(screen.getByText("From")).toBeTruthy();
    expect(screen.getByText("Thu")).toBeTruthy();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
      "https://example.com/docs",
    );
  });

  it("shows unknown blocks and elements instead of hiding them", () => {
    const blocks = [
      { type: "image", image_url: "https://example.com/x.png" },
      { type: "actions", elements: [{ type: "overflow", action_id: "more" }] },
    ] as unknown as Block[];
    render(<Blocks blocks={blocks} />);
    expect(screen.getByText("unsupported block: image")).toBeTruthy();
    expect(screen.getByText("unsupported element: overflow")).toBeTruthy();
  });
});
