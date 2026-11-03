import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GlossaryTermId } from "@/lib/glossary";
import { glossaryTerm } from "@/lib/glossary";

import { Term } from "./Term";

/**
 * The two states the component can be in, and the one thing that must hold in
 * both: the word is on the page and the definition is reachable from it with the
 * keyboard.
 *
 * jsdom does not implement the popover API, which is exactly the situation the
 * fallback exists for, so the default test *is* the degradation test. The
 * enhanced state is made testable by putting a `showPopover` on the prototype for
 * the length of one test — the same feature detection the component runs, not a
 * mock of the component.
 */
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");

function setPopoverSupport(supported: boolean): void {
  if (supported) {
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      value: () => undefined,
      configurable: true,
      writable: true,
    });
  } else {
    delete (HTMLElement.prototype as unknown as { showPopover?: unknown }).showPopover;
  }
}

/**
 * React writes an inline style either as a property (`style.anchorName = …`) or
 * through `setProperty`, depending on whether the name is custom; jsdom keeps
 * whichever it understands. Reading all three places is the only honest way to
 * ask "did the style reach the element?" without depending on the CSS engine.
 */
function inlineStyle(element: HTMLElement, property: string): string {
  const camel = property.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
  const asProperty = (element.style as unknown as Record<string, string | undefined>)[
    camel
  ];
  return (
    asProperty ||
    element.style.getPropertyValue(property) ||
    element.getAttribute("style") ||
    ""
  );
}

afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(HTMLElement.prototype, "showPopover", original);
  else setPopoverSupport(false);
});

describe("Term without popover support", () => {
  it("renders the word as a link to its glossary anchor", () => {
    setPopoverSupport(false);
    render(<Term name="coverage">coverage</Term>);
    const link = screen.getByRole("link", { name: "coverage" });
    expect(link.getAttribute("href")).toBe("/glossary/#coverage");
    expect(link.className).toContain("term");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the term's own label when no children are given", () => {
    setPopoverSupport(false);
    render(<Term name="hhi" />);
    expect(screen.getByRole("link", { name: "HHI" }).getAttribute("href")).toBe(
      "/glossary/#hhi",
    );
  });
});

describe("Term with popover support", () => {
  it("renders a button that targets its own popover", () => {
    setPopoverSupport(true);
    render(<Term name="coverage">coverage</Term>);

    const button = screen.getByRole("button", { name: "coverage" });
    expect(button.getAttribute("type")).toBe("button");
    const target = button.getAttribute("popovertarget");
    expect(target).toBeTruthy();
    if (!target) return;

    const popover = document.getElementById(target);
    expect(popover).toBeTruthy();
    // `auto` is what gives Escape, light-dismiss and focus return for free.
    expect(popover?.getAttribute("popover")).toBe("auto");
    expect(popover?.getAttribute("role")).toBe("note");
    expect(popover?.textContent).toContain(glossaryTerm("coverage")?.short ?? "missing");
    const link = popover?.querySelector("a.popover__link");
    expect(link?.getAttribute("href")).toBe("/glossary/#coverage");
  });

  it("gives each instance its own anchor, so two words do not share a popover", () => {
    setPopoverSupport(true);
    const { container } = render(
      <>
        <Term name="coverage">coverage</Term>
        <Term name="coverage">coverage again</Term>
      </>,
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    const targets = buttons.map((button) => button.getAttribute("popovertarget"));
    expect(new Set(targets).size).toBe(2);

    // The anchor name has to be a valid custom identifier (`--name`): an invalid
    // one is ignored silently and every popover lands in the same place.
    const anchors = buttons.map((button) => inlineStyle(button, "anchor-name"));
    for (const anchor of anchors)
      expect(anchor).toMatch(/--term-coverage-[A-Za-z0-9_-]+/);
    expect(new Set(anchors).size).toBe(2);

    // And each popover points at its own button's anchor, not a neighbour's.
    for (const [index, button] of buttons.entries()) {
      const id = button.getAttribute("popovertarget");
      const popover = id ? document.getElementById(id) : null;
      expect(popover).toBeTruthy();
      if (popover) {
        const positioned = inlineStyle(popover, "position-anchor");
        expect(positioned).toContain(anchors[index]?.trim() ?? "missing");
      }
    }
  });

  it("leaves the sentence around it alone", () => {
    setPopoverSupport(true);
    const { container } = render(
      <p>
        Coverage is <Term name="coverage">a share of weight</Term>.
      </p>,
    );
    const paragraph = container.querySelector("p");
    // The words before and after the term are untouched, and the definition is a
    // popover rather than a second sentence: the element is in the paragraph (a
    // span, since a paragraph cannot hold a div) and out of layout until opened.
    expect(paragraph?.firstChild?.textContent).toBe("Coverage is ");
    expect(paragraph?.querySelector("[popover]")).toBeTruthy();
    expect(paragraph?.querySelector("[popover]")?.tagName).toBe("SPAN");
  });
});

describe("Term with a name that is not in the registry", () => {
  it("still renders the words rather than an empty box", () => {
    setPopoverSupport(true);
    render(<Term name={"not-a-term" as GlossaryTermId}>something</Term>);
    expect(screen.getByText("something")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
