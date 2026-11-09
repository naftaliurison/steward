// @vitest-environment jsdom
import {
  datepicker,
  input,
  type ModalView,
  option,
  plain,
  staticSelect,
  textInput,
} from "@steward/core/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";
import { initialValues } from "./values";

afterEach(cleanup);

/** The same shape as the product's status form. */
const view: ModalView = {
  type: "modal",
  callback_id: "ooo_status",
  title: plain("Set your availability"),
  submit: plain("Save"),
  close: plain("Cancel"),
  blocks: [
    input(
      "type",
      "What's happening?",
      staticSelect(
        "type",
        [option("Out of office", "out"), option("Sick", "sick")],
        option("Out of office", "out"),
      ),
    ),
    input("from", "From", datepicker("from", "2026-11-12")),
    input("to", "To (last day)", datepicker("to", "2026-11-12")),
    input("text", "Status text", textInput("text", "Out of office"), true),
    input("emoji", "Emoji", textInput("emoji", ":palm_tree:", ":palm_tree:"), true),
  ],
};

function show(over: Partial<Parameters<typeof Modal>[0]> = {}) {
  const props = {
    view,
    values: initialValues(view),
    errors: {},
    busy: false,
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<Modal {...props} />);
  return props;
}

describe("initialValues", () => {
  it("reads every input block's starting value", () => {
    expect(initialValues(view)).toEqual({
      type: "out",
      from: "2026-11-12",
      to: "2026-11-12",
      text: "Out of office",
      emoji: ":palm_tree:",
    });
  });
});

describe("Modal", () => {
  it("is a labelled dialog whose fields carry the form's values", () => {
    show();
    expect(screen.getByRole("dialog", { name: "Set your availability" })).toBeTruthy();
    expect((screen.getByLabelText("What's happening?") as HTMLSelectElement).value).toBe("out");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-11-12");
    expect((screen.getByLabelText(/Status text/) as HTMLInputElement).value).toBe("Out of office");
  });

  it("reports edits, submit and both ways of closing", () => {
    const props = show();
    fireEvent.change(screen.getByLabelText("To (last day)"), { target: { value: "2026-11-13" } });
    expect(props.onChange).toHaveBeenCalledWith("to", "2026-11-13");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("shows each error under its field, and an error for no field at the top", () => {
    show({
      errors: {
        to: "The last day has already passed.",
        nowhere: "Steward couldn't reach its records.",
      },
    });
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts).toContain("The last day has already passed.");
    expect(alerts).toContain("Steward couldn't reach its records.");
  });

  it("disables Save while busy and shows an unknown element instead of hiding it", () => {
    const odd = {
      ...view,
      blocks: [
        ...view.blocks,
        {
          type: "input",
          block_id: "who",
          label: plain("Who"),
          element: { type: "multi_users_select", action_id: "who" },
        },
      ],
    } as unknown as ModalView;
    show({ view: odd, busy: true });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("unsupported element: multi_users_select")).toBeTruthy();
  });
});
