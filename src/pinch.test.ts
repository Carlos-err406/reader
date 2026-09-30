import { describe, expect, it } from "vitest";
import { clampZoom, stepZoom } from "./pinch";

describe("zoom", () => {
  it("steps through comfortable levels and back to fit", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.25, -1)).toBe(1);
    // An odd pinch level still steps to the neighbouring level, passing through 100%.
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(0.93, 1)).toBe(1);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("clamps pinches to the supported range", () => {
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(1.2345)).toBe(1.23);
  });
});
