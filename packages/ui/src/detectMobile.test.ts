import { MOBILE_BREAKPOINT_PX } from "@intervals-mcp/design-system";
import { describe, expect, it } from "vitest";
import { detectMobile, widthFromHost } from "./useMobileMode";

const WIDE = MOBILE_BREAKPOINT_PX + 200;
const NARROW = MOBILE_BREAKPOINT_PX - 1;

describe("widthFromHost", () => {
  it("reads fixed width, then bounded maxWidth", () => {
    expect(widthFromHost({ width: 360, height: 780 })).toBe(360);
    expect(widthFromHost({ maxWidth: 480 })).toBe(480);
  });

  it("returns undefined when the host reports nothing usable", () => {
    expect(widthFromHost(undefined)).toBeUndefined();
    expect(widthFromHost({} as never)).toBeUndefined();
  });
});

describe("detectMobile", () => {
  it("returns false on a plain wide desktop", () => {
    expect(detectMobile({ userAgent: "Mozilla/5.0 (Macintosh)" }, WIDE)).toBe(
      false,
    );
  });

  it("signal 1: explicit platform === 'mobile'", () => {
    expect(
      detectMobile(
        { platform: "mobile", userAgent: "Mozilla/5.0 (Macintosh)" },
        WIDE,
      ),
    ).toBe(true);
  });

  it("signal 2: touch-only device (touch && !hover)", () => {
    expect(
      detectMobile(
        {
          deviceCapabilities: { touch: true, hover: false },
          userAgent: "x",
        },
        WIDE,
      ),
    ).toBe(true);
    // Touch laptops (touch && hover) are NOT mobile by this signal.
    expect(
      detectMobile(
        {
          deviceCapabilities: { touch: true, hover: true },
          userAgent: "x",
        },
        WIDE,
      ),
    ).toBe(false);
  });

  it("signal 3: host-reported container width under the breakpoint", () => {
    expect(
      detectMobile(
        {
          containerDimensions: { width: NARROW, height: 780 },
          userAgent: "x",
        },
        WIDE,
      ),
    ).toBe(true);
  });

  it("signal 4: live viewport width under the breakpoint", () => {
    expect(detectMobile({ userAgent: "x" }, NARROW)).toBe(true);
  });

  it("signal 5: UA sniff as last resort", () => {
    expect(
      detectMobile(
        {
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        },
        WIDE,
      ),
    ).toBe(true);
    expect(
      detectMobile({ userAgent: "Mozilla/5.0 (Linux; Android 14)" }, WIDE),
    ).toBe(true);
  });
});
