/** the kit stepper (review of #690): the current step is marked, a finished step says "done" to a screen reader */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stepper } from "./Stepper";

const html = (current: "a" | "b" | "c") =>
  renderToStaticMarkup(
    <Stepper
      label="Set-up"
      current={current}
      onSelect={() => undefined}
      steps={[
        { id: "a", label: "First", done: true, status: <em>ok</em> },
        { id: "b", label: "Second", done: false },
        { id: "c", label: "Third", done: true },
      ]}
    />,
  );

describe("Stepper", () => {
  it("names the list, marks only the current step, and states each step's status inside its button", () => {
    const out = html("b");
    expect(out).toMatch(/<ol class="[^"]*" aria-label="Set-up">/);
    expect(out.match(/aria-current="step"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="step"[^>]*>.*?Second/);
    expect(out).toMatch(/First<\/span>.*?<em>ok<\/em><\/button>/);
  });

  it("a finished step shows a decorative ✓ and says done; the current step shows its number, never done", () => {
    const out = html("c");
    const buttons = out.split("<button").slice(1);
    expect(buttons[0]).toMatch(/aria-hidden="true">✓<\/span>/);
    expect(buttons[0]).toContain(" (done)");
    expect(buttons[1]).toMatch(/aria-hidden="true">2<\/span>/);
    expect(buttons[1]).not.toContain("(done)");
    // the current step was finished, but it is the one open, so it reads as its number
    expect(buttons[2]).toMatch(/aria-hidden="true">3<\/span>/);
    expect(buttons[2]).not.toContain("(done)");
  });
});
