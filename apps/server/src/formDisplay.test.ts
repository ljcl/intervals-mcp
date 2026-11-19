import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORM_DISPLAY_TTL_MS,
  loadFormDisplay,
  resetFormDisplay,
} from "./formDisplay";
import { getAthleteFormAsPercent } from "./intervalsClient";

vi.mock("./intervalsClient", () => ({ getAthleteFormAsPercent: vi.fn() }));

const mockedRead = vi.mocked(getAthleteFormAsPercent);

beforeEach(() => {
  mockedRead.mockReset();
  resetFormDisplay();
});

describe("loadFormDisplay (#512)", () => {
  it("maps the athlete setting to the display", async () => {
    mockedRead.mockResolvedValueOnce(true);
    expect(await loadFormDisplay("k")).toBe("percent");
    resetFormDisplay();
    mockedRead.mockResolvedValueOnce(false);
    expect(await loadFormDisplay("k")).toBe("absolute");
  });

  it("reads once per hour, then again", async () => {
    let now = 1_000_000;
    mockedRead.mockResolvedValue(true);

    await loadFormDisplay("k", () => now);
    now += FORM_DISPLAY_TTL_MS - 1;
    await loadFormDisplay("k", () => now);
    expect(mockedRead).toHaveBeenCalledTimes(1);

    mockedRead.mockResolvedValue(false);
    now += 1;
    expect(await loadFormDisplay("k", () => now)).toBe("absolute");
    expect(mockedRead).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read, and does not hide it", async () => {
    const failure = new Error("upstream");
    mockedRead.mockRejectedValueOnce(failure);
    await expect(loadFormDisplay("k")).rejects.toBe(failure);

    mockedRead.mockResolvedValueOnce(true);
    expect(await loadFormDisplay("k")).toBe("percent");
  });
});
