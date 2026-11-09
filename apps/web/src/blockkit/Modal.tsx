import type { Element, ModalView } from "@steward/core/blocks";
import { useEffect, useId, useRef } from "react";
import { Blocks, Unsupported } from "./Blocks";
import { emojify } from "./emoji";
import type { Values } from "./values";

const FIELD =
  "w-full rounded border border-neutral-400 bg-white px-2 py-1.5 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";
const FOOT_BUTTON = "rounded border px-3 py-1.5 text-sm font-bold disabled:opacity-50";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function InputElement(props: {
  id: string;
  el: Element;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const { id, el, value, error, onChange } = props;
  const a11y = error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
  if (el.type === "static_select") {
    const known = el.options.some((o) => o.value === value);
    return (
      <select
        id={id}
        className={FIELD}
        value={known ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        {...a11y}
      >
        {known ? null : <option value="">{el.placeholder?.text ?? "Choose…"}</option>}
        {el.options.map((o) => (
          <option key={o.value} value={o.value}>
            {emojify(o.text.text)}
          </option>
        ))}
      </select>
    );
  }
  if (el.type === "datepicker")
    return (
      <input
        id={id}
        className={FIELD}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...a11y}
      />
    );
  if (el.type === "plain_text_input")
    return (
      <input
        id={id}
        className={FIELD}
        type="text"
        value={value}
        placeholder={el.placeholder?.text}
        onChange={(e) => onChange(e.target.value)}
        {...a11y}
      />
    );
  return <Unsupported what="element" type={(el as { type: string }).type} />;
}

export function Modal(props: {
  view: ModalView;
  values: Values;
  errors: Record<string, string>;
  busy: boolean;
  onChange: (blockId: string, value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { view, values, errors, busy, onChange, onSubmit, onClose } = props;
  const titleId = useId();
  const fieldPrefix = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Focus goes into the dialog when it opens and back to where it was when it closes.
  useEffect(() => {
    const dialog = dialogRef.current;
    const before = document.activeElement;
    const field = dialog?.querySelector<HTMLElement>(
      "input:not([disabled]),select:not([disabled]),textarea:not([disabled])",
    );
    (field ?? dialog)?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  const keepTabInside = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = e.currentTarget;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!first || !last) {
      e.preventDefault();
      dialog.focus();
    } else if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const fieldIds = new Set(view.blocks.flatMap((b) => (b.type === "input" ? [b.block_id] : [])));
  const strayErrors = Object.entries(errors).filter(([blockId]) => !fieldIds.has(blockId));

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepTabInside}
        className="mt-10 w-full max-w-lg rounded-lg bg-white text-neutral-900 shadow-xl dark:bg-neutral-900 dark:text-neutral-100"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-700">
            <h2 id={titleId} className="text-lg font-bold">
              {emojify(view.title.text)}
            </h2>
            <button
              type="button"
              aria-label="Close"
              className="px-2 text-neutral-500"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
          <div className="space-y-4 px-5 py-4">
            {strayErrors.map(([blockId, message]) => (
              <p key={blockId} role="alert" className="text-sm text-rose-600">
                {message}
              </p>
            ))}
            {view.blocks.map((block, i) => {
              if (block.type !== "input")
                // biome-ignore lint/suspicious/noArrayIndexKey: a view's blocks are a fixed list that never reorders
                return <Blocks key={i} blocks={[block]} />;
              const id = `${fieldPrefix}-${block.block_id}`;
              const error = errors[block.block_id];
              return (
                <div key={block.block_id}>
                  <label htmlFor={id} className="mb-1 block text-sm font-bold">
                    {emojify(block.label.text)}
                    {block.optional ? (
                      <span className="ml-1 font-normal text-neutral-500"> (optional)</span>
                    ) : null}
                  </label>
                  <InputElement
                    id={id}
                    el={block.element}
                    value={values[block.block_id] ?? ""}
                    error={error}
                    onChange={(v) => onChange(block.block_id, v)}
                  />
                  {error ? (
                    <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-rose-600">
                      {error}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-700">
            <button type="button" className={`${FOOT_BUTTON} border-neutral-400`} onClick={onClose}>
              {view.close?.text ?? "Cancel"}
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`${FOOT_BUTTON} border-emerald-700 bg-emerald-700 text-white`}
            >
              {view.submit?.text ?? "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
