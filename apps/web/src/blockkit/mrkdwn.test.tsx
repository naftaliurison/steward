// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mrkdwn } from "./mrkdwn";

afterEach(cleanup);

describe("mrkdwn", () => {
  it("renders bold, italic, code, line breaks and the product's emoji", () => {
    const { container } = render(
      <p>{mrkdwn("✅ *Slack status* set — clears _Tue_\n`/ooo` :palm_tree: :shrug:")}</p>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Slack status");
    expect(container.querySelector("em")?.textContent).toBe("Tue");
    expect(container.querySelector("code")?.textContent).toBe("/ooo");
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container.textContent).toContain("🌴");
    expect(container.textContent).toContain(":shrug:"); // not one of the product's: shown as typed
  });

  it("treats markup in the text as text", () => {
    const { container } = render(<p>{mrkdwn("<img src=x onerror=alert(1)> & more")}</p>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("<img src=x onerror=alert(1)> & more");
  });

  it("needs a non-word character outside an underscore pair", () => {
    const { container } = render(<p>{mrkdwn("snake_case_name and _it_")}</p>);
    expect(container.textContent).toBe("snake_case_name and it");
    expect(container.querySelectorAll("em")).toHaveLength(1);
    expect(container.querySelector("em")?.textContent).toBe("it");
  });

  it("does not open or close emphasis next to a space", () => {
    const { container } = render(<p>{mrkdwn("2 * 3 * 4")}</p>);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("2 * 3 * 4");
  });

  it("shows a code span literally", () => {
    const { container } = render(<p>{mrkdwn("a `code :palm_tree: *x*` b :palm_tree:")}</p>);
    expect(container.querySelector("code")?.textContent).toBe("code :palm_tree: *x*");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("a code :palm_tree: *x* b 🌴");
  });

  it("keeps the simple cases", () => {
    const { container } = render(<p>{mrkdwn("*a* and *b* *unclosed")}</p>);
    expect(container.querySelectorAll("strong")).toHaveLength(2);
    expect(container.textContent).toBe("a and b *unclosed");
    expect(mrkdwn("")).toEqual([]);
  });
});
