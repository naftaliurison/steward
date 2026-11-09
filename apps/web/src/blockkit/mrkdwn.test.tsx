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
});
