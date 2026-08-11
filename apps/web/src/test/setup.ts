import "@testing-library/jest-dom/vitest";

import { configure } from "@testing-library/dom";
import { afterEach, vi } from "vitest";

// Large XLSX parser regressions and page-level tests run in the same suite.
// Keep async UI assertions strict, while allowing normal CI/Windows resource
// contention to settle instead of treating the library's 1s default as a bug.
configure({ asyncUtilTimeout: 5_000 });

class ResizeObserverMock implements ResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});
