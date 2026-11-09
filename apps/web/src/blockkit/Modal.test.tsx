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
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("moves focus into the dialog, keeps Tab inside it, and gives focus back on close", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <Modal
        view={view}
        values={initialValues(view)}
        errors={{}}
        busy={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("What's happening?"));

    const last = screen.getByRole("button", { name: "Save" });
    const first = within(dialog).getByRole("button", { name: "Close" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("focuses the dialog itself when it has no field", () => {
    show({ view: { ...view, blocks: [] }, values: {} });
    const dialog = screen.getByRole("dialog");
    expect(dialog.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(dialog);
  });

  it("closes on Escape unless the key was already handled, and stops listening once gone", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Modal
        view={view}
        values={initialValues(view)}
        errors={{}}
        busy={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("subscribes to Escape once and calls the latest onClose", () => {
    const add = vi.spyOn(window, "addEventListener");
    const first = vi.fn();
    const second = vi.fn();
    const base = {
      view,
      values: initialValues(view),
      errors: {},
      busy: false,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(<Modal {...base} onClose={first} />);
    rerender(<Modal {...base} onClose={second} />);
    expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    add.mockRestore();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("marks a field with an error invalid and describes it by its error", () => {
    show({ errors: { to: "The last day has already passed." } });
    const field = screen.getByLabelText("To (last day)");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const described = document.getElementById(field.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("The last day has already passed.");
    expect(described?.getAttribute("role")).toBe("alert");
    expect(field.parentElement?.contains(described ?? null)).toBe(true);
    expect(
      field.compareDocumentPosition(described as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByLabelText("From").getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByLabelText("From").getAttribute("aria-describedby")).toBeNull();
  });

  it("shows the placeholder when the value is not one of the options", () => {
    show({ values: { ...initialValues(view), type: "vacation" } });
    const select = screen.getByLabelText("What's happening?") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent).toBe("Choose…");
  });
});
