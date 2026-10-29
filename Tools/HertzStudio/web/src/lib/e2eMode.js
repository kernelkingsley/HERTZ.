/**
 * Explicit Studio E2E mode. Must be established before app modules initialize
 * (Playwright addInitScript sets window.__HERTZ_E2E_MODE__ = true, or ?hertzE2e=1).
 * Frozen on first read so later URL/window changes cannot enable hooks mid-session.
 */

let frozen = null;

export function freezeE2eModeFromBoot() {
  if (frozen !== null) return frozen;
  if (typeof window === "undefined") {
    frozen = false;
    return frozen;
  }
  const fromWindow = window.__HERTZ_E2E_MODE__ === true;
  let fromQuery = false;
  try {
    fromQuery = new URLSearchParams(window.location.search).get("hertzE2e") === "1";
  } catch {
    fromQuery = false;
  }
  frozen = Boolean(fromWindow || fromQuery);
  window.__HERTZ_E2E_MODE__ = frozen;
  return frozen;
}

export function isHertzE2eMode() {
  if (frozen === null) return freezeE2eModeFromBoot();
  return frozen;
}

/** Test helper — reset freeze between Vitest/node cases only. */
export function resetE2eModeForTests() {
  frozen = null;
}
