// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import guard from "../../public/startup-guard.js?raw";

afterEach(() => {
  window.dispatchEvent(new Event("suivelle-startup-ready"));
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function boot() {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div><div id="startup"><span id="startup-status">Opening</span><button id="startup-retry" hidden>Try again</button></div>';
  Function(guard)();
}

describe("startup recovery outside React", () => {
  it("keeps a visible loading state through a slow boot and removes it only after commit", () => {
    boot();
    vi.advanceTimersByTime(15000);
    expect(document.querySelector("#startup-status")?.textContent).toContain("Still preparing");
    expect(document.querySelector<HTMLButtonElement>("#startup-retry")?.hidden).toBe(false);
    window.dispatchEvent(new Event("suivelle-startup-ready"));
    expect(document.getElementById("startup")).toBeNull();
  });

  it("provides recovery when a module cannot load", () => {
    boot();
    const script = document.createElement("script");
    document.body.append(script);
    script.dispatchEvent(new Event("error"));
    expect(document.querySelector("#startup-status")?.textContent).toContain("could not finish");
    vi.advanceTimersByTime(15000);
    expect(document.querySelector("#startup-status")?.textContent).toContain("could not finish");
  });

  it("handles failed safety checks and ignores unrelated errors after startup", () => {
    boot();
    window.dispatchEvent(new Event("suivelle-startup-failed"));
    expect(document.querySelector<HTMLButtonElement>("#startup-retry")?.hidden).toBe(false);
    window.dispatchEvent(new Event("suivelle-startup-ready"));
    window.dispatchEvent(new Event("suivelle-startup-failed"));
    expect(document.getElementById("startup")).toBeNull();
  });

  it("offers recovery for a stalled bridge and can still complete afterward", () => {
    boot();
    vi.advanceTimersByTime(65000);
    expect(document.querySelector("#startup-status")?.textContent).toContain("could not finish");
    window.dispatchEvent(new Event("suivelle-startup-ready"));
    expect(document.getElementById("startup")).toBeNull();
  });

  it("catches errors before the application entry point can install its boundary", () => {
    boot();
    window.dispatchEvent(new Event("unhandledrejection"));
    expect(document.querySelector("#startup-status")?.textContent).toContain("could not finish");
  });
});
