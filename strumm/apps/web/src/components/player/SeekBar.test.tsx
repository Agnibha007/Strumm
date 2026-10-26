import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import SeekBar from "./SeekBar";

function slider() {
  return screen.getByRole("slider");
}

function press(key: string) {
  fireEvent.keyDown(slider(), { key });
}

describe("SeekBar", () => {
  it("exposes itself as a labelled slider with a spoken position", () => {
    render(<SeekBar currentTime={83} duration={247} onSeek={() => {}} />);

    const el = screen.getByRole("slider", { name: "Playback position" });
    expect(el.getAttribute("aria-valuemin")).toBe("0");
    expect(el.getAttribute("aria-valuemax")).toBe("247");
    expect(el.getAttribute("aria-valuenow")).toBe("83");
    expect(el.getAttribute("aria-valuetext")).toBe("1:23 of 4:07");
    expect(el.getAttribute("tabindex")).toBe("0");
  });

  it("is keyboard seekable — a mouse is not required", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={100} duration={200} onSeek={onSeek} />);

    press("ArrowRight");
    expect(onSeek).toHaveBeenLastCalledWith(105);

    press("ArrowLeft");
    expect(onSeek).toHaveBeenLastCalledWith(95);

    press("PageUp");
    expect(onSeek).toHaveBeenLastCalledWith(130);

    press("PageDown");
    expect(onSeek).toHaveBeenLastCalledWith(70);

    press("Home");
    expect(onSeek).toHaveBeenLastCalledWith(0);

    press("End");
    expect(onSeek).toHaveBeenLastCalledWith(200);
  });

  it("supports the up/down arrow aliases", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={100} duration={200} onSeek={onSeek} />);

    press("ArrowUp");
    expect(onSeek).toHaveBeenLastCalledWith(105);
    press("ArrowDown");
    expect(onSeek).toHaveBeenLastCalledWith(95);
  });

  it("never seeks past the bounds", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={9} duration={10} onSeek={onSeek} />);

    press("ArrowRight");
    expect(onSeek).toHaveBeenLastCalledWith(10);

    press("ArrowLeft");
    press("ArrowLeft");
    expect(onSeek).toHaveBeenLastCalledWith(4);
  });

  it("clamps at the start when seeking backwards", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={2} duration={10} onSeek={onSeek} />);

    press("ArrowLeft");
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it("seeks to the clicked position", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={0} duration={100} onSeek={onSeek} />);

    const el = slider();
    // jsdom has no layout, so give the element a measurable rect: the midpoint
    // should map to 50 of 100 seconds.
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 8,
      width: 200,
      height: 8,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(el, { clientX: 100 });

    expect(onSeek).toHaveBeenLastCalledWith(50);
  });

  it("ignores clicks when the duration is unknown", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={0} duration={0} onSeek={onSeek} />);

    fireEvent.click(slider(), { clientX: 50 });

    expect(onSeek).not.toHaveBeenCalled();
  });

  it("treats an unknown duration as not seekable", () => {
    render(<SeekBar currentTime={0} duration={0} onSeek={() => {}} />);

    expect(slider().getAttribute("aria-disabled")).toBe("true");
    expect(slider().getAttribute("tabindex")).toBe("-1");
  });

  it("announces 0:00 of 0:00 when nothing has loaded", () => {
    render(<SeekBar currentTime={0} duration={0} onSeek={() => {}} />);

    expect(slider().getAttribute("aria-valuetext")).toBe("0:00 of 0:00");
  });

  it("honours the step override", () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={50} duration={200} onSeek={onSeek} stepSeconds={10} />);

    press("ArrowRight");
    expect(onSeek).toHaveBeenLastCalledWith(60);
  });

  it("uses a custom accessible name", () => {
    render(<SeekBar currentTime={1} duration={2} onSeek={() => {}} label="Episode position" />);

    expect(screen.getByRole("slider", { name: "Episode position" })).toBeTruthy();
  });

  it("prevents the page from scrolling when an arrow key seeks", () => {
    render(<SeekBar currentTime={50} duration={200} onSeek={() => {}} />);

    const el = slider();
    const event = createEvent.keyDown(el, { key: "ArrowRight" });
    fireEvent(el, event);

    expect(event.defaultPrevented).toBe(true);
  });
});
