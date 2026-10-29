import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freezeE2eModeFromBoot, isHertzE2eMode, resetE2eModeForTests } from "./e2eMode.js";

describe("e2eMode", () => {
  const prev = globalThis.window;

  beforeEach(() => {
    resetE2eModeForTests();
    globalThis.window = {
      __HERTZ_E2E_MODE__: undefined,
      location: { search: "" },
    };
  });

  afterEach(() => {
    resetE2eModeForTests();
    globalThis.window = prev;
  });

  it("is absent / false during normal Studio boot", () => {
    expect(freezeE2eModeFromBoot()).toBe(false);
    expect(isHertzE2eMode()).toBe(false);
    expect(globalThis.window.__HERTZ_E2E_MODE__).toBe(false);
  });

  it("enables when window flag is set before freeze", () => {
    globalThis.window.__HERTZ_E2E_MODE__ = true;
    expect(freezeE2eModeFromBoot()).toBe(true);
    expect(isHertzE2eMode()).toBe(true);
  });

  it("enables from ?hertzE2e=1 before freeze", () => {
    globalThis.window.location = { search: "?hertzE2e=1" };
    expect(freezeE2eModeFromBoot()).toBe(true);
  });

  it("does not enable from a late window flag after freeze", () => {
    freezeE2eModeFromBoot();
    globalThis.window.__HERTZ_E2E_MODE__ = true;
    expect(isHertzE2eMode()).toBe(false);
  });
});
