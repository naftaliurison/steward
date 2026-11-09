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

  it("turns only http and https URLs into links", () => {
    const blocks: Block[] = [
      actions(
        button("Good", "a", { url: "https://example.com/docs" }),
        button("Script", "b", { url: "javascript:alert(1)" }),
        button("Data", "c", { url: "data:text/html,x" }),
        button("Junk", "d", { url: "not a url" }),
      ),
    ];
    const { container } = render(<Blocks blocks={blocks} />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Good" }).getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(screen.getAllByText("unsupported element: button (link not allowed)")).toHaveLength(3);
  });

  describe("malformed blocks", () => {
    const show = (bad: unknown) =>
      render(<Blocks blocks={[bad, section("Still here")] as unknown as Block[]} />);

    it("shows a null block and a block without a type", () => {
      show(null);
      show({ text: "x" });
      expect(screen.getAllByText("unsupported block: (no type)")).toHaveLength(2);
      expect(screen.getAllByText("Still here")).toHaveLength(2);
    });

    it.each([
      ["actions without elements", { type: "actions" }],
      ["context without elements", { type: "context" }],
    ])("renders %s as empty", (_name, bad) => {
      show(bad);
      expect(screen.queryByRole("note")).toBeNull();
      expect(screen.getByText("Still here")).toBeTruthy();
    });

    it("shows a header without text", () => {
      show({ type: "header" });
      expect(screen.getByText("unsupported block: header (no text)")).toBeTruthy();
      expect(screen.getByText("Still here")).toBeTruthy();
    });

    it("shows a button without text and a null element", () => {
      show({ type: "actions", elements: [{ type: "button", action_id: "x" }, null] });
      expect(screen.getByText("unsupported element: button (no text)")).toBeTruthy();
      expect(screen.getByText("unsupported element: (no type)")).toBeTruthy();
      expect(screen.getByText("Still here")).toBeTruthy();
    });

    it("shows a context element that is not text", () => {
      show({ type: "context", elements: [{ type: "image" }, { type: "mrkdwn", text: "ok" }] });
      expect(screen.getByText("unsupported element: image")).toBeTruthy();
      expect(screen.getByText("ok")).toBeTruthy();
      expect(screen.getByText("Still here")).toBeTruthy();
    });

    it("shows an empty section", () => {
      show({ type: "section" });
      expect(screen.getByText("unsupported block: section (empty)")).toBeTruthy();
      expect(screen.getByText("Still here")).toBeTruthy();
    });

    it("catches anything else in a per-block boundary", () => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      show({
        type: "section",
        get text(): never {
          throw new Error("boom");
        },
      });
      quiet.mockRestore();
      expect(screen.getByText("unsupported block: section")).toBeTruthy();
      expect(screen.getByText("Still here")).toBeTruthy();
    });
  });
});
