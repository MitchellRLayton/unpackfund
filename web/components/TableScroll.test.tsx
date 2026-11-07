import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TableScroll } from "./TableScroll";

/**
 * The reachable scrollbar.
 *
 * jsdom does no layout, so the geometry the component reads — `scrollWidth`,
 * `clientWidth`, `scrollLeft` — is defined here rather than measured. That is the
 * point: the component's only arithmetic is the thumb's width and position, and these
 * tests pin it against numbers a browser would produce, not against whatever jsdom
 * happens to return.
 */

/** A box 400 px wide showing 1000 px of table, scrolled to `left`. */
function geometry(box: HTMLElement, left = 0) {
  let scrollLeft = left;
  Object.defineProperty(box, "scrollWidth", { configurable: true, value: 1000 });
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 400 });
  Object.defineProperty(box, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = Math.max(0, Math.min(value, 600));
    },
  });
}

function rail(): HTMLElement | null {
  return document.querySelector(".table-scroll__rail");
}

function thumb(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".table-scroll__thumb");
  if (!found) throw new Error("no thumb");
  return found;
}

beforeEach(() => {
  // jsdom has no ResizeObserver and no pointer capture; the component uses both.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TableScroll", () => {
  it("is one focusable region with a name, so the arrow keys can scroll it", () => {
    render(
      <TableScroll label="Your funds">
        <table>
          <tbody>
            <tr>
              <td>VTI</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );

    const region = screen.getByRole("region", { name: "Your funds" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toBe("table-wrap");
    expect(region.querySelector("table")).not.toBeNull();
  });

  it("draws no rail when the table fits", () => {
    render(
      <TableScroll label="Your funds">
        <table />
      </TableScroll>,
    );
    const box = screen.getByRole("region");
    Object.defineProperty(box, "scrollWidth", { configurable: true, value: 400 });
    Object.defineProperty(box, "clientWidth", { configurable: true, value: 400 });
    fireEvent.scroll(box);
    expect(rail()).toBeNull();
  });

  it("draws a rail whose thumb is the visible share of the table", () => {
    render(
      <TableScroll label="Your funds">
        <table />
      </TableScroll>,
    );
    const box = screen.getByRole("region");
    geometry(box, 0);
    fireEvent.scroll(box);

    expect(rail()).not.toBeNull();
    // 400 of 1000 px visible: the thumb is 40% of the track, at its left edge.
    expect(thumb().style.width).toBe("40%");
    expect(thumb().style.marginLeft).toBe("0%");
  });

  it("moves the thumb when the table is scrolled, and stops at the end", () => {
    render(
      <TableScroll label="Your funds">
        <table />
      </TableScroll>,
    );
    const box = screen.getByRole("region");
    geometry(box, 0);
    fireEvent.scroll(box);

    box.scrollLeft = 300;
    fireEvent.scroll(box);
    // Half of the 600 px of travel: the thumb's left edge is 30% along the track.
    expect(thumb().style.marginLeft).toBe("30%");

    box.scrollLeft = 600;
    fireEvent.scroll(box);
    // 60% offset + 40% width = the track, exactly.
    expect(thumb().style.marginLeft).toBe("60%");
  });

  it("scrolls the table when the thumb is dragged", () => {
    render(
      <TableScroll label="Your funds">
        <table />
      </TableScroll>,
    );
    const box = screen.getByRole("region");
    geometry(box, 0);
    fireEvent.scroll(box);

    const track = rail();
    if (!track) throw new Error("no rail");
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 400 });

    fireEvent.pointerDown(thumb(), { pointerId: 1, clientX: 100 });
    // The thumb has 240 px of travel for the table's 600 px, so 120 px of pointer
    // movement is half the table.
    fireEvent.pointerMove(thumb(), { pointerId: 1, clientX: 220 });
    expect(box.scrollLeft).toBe(300);
    fireEvent.pointerUp(thumb(), { pointerId: 1, clientX: 220 });
  });

  it("pages the table when the track is clicked, and never past either end", () => {
    render(
      <TableScroll label="Your funds">
        <table />
      </TableScroll>,
    );
    const box = screen.getByRole("region");
    geometry(box, 0);
    fireEvent.scroll(box);

    const track = rail();
    if (!track) throw new Error("no rail");
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 400 });
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 400, top: 0, height: 18, right: 400, bottom: 18 }) as DOMRect;

    // A click on the right half pages forward by 80% of the visible width.
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 350 });
    expect(box.scrollLeft).toBe(320);

    // A click on the left half pages back, and the first page cannot go below zero.
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 50 });
    expect(box.scrollLeft).toBe(0);
  });
});
