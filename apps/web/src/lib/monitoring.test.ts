import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureReactException: vi.fn() }));
vi.mock("@sentry/react", () => sentry);

import { reportCaughtReactError, startMonitoring } from "./monitoring";

function respond(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("browser monitoring", () => {
  beforeEach(() => {
    sentry.init.mockReset();
    sentry.captureReactException.mockReset();
  });

  it("stays off when the API has no browser DSN or cannot be reached", async () => {
    expect(await startMonitoring(respond({ dsn: null }))).toBe(false);
    expect(await startMonitoring(respond({}, 404))).toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await startMonitoring(offline)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("starts the SDK through the API tunnel with data collection off", async () => {
    const fetchImpl = respond({
      dsn: "https://key@errors.example.com/8",
      environment: "lg-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
    });
    expect(await startMonitoring(fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/monitoring/config");
    const options = sentry.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: "https://key@errors.example.com/8",
      environment: "lg-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false },
    });
    expect(options.integrations([{ name: "BrowserSession" }, { name: "GlobalHandlers" }])).toEqual([
      { name: "GlobalHandlers" },
    ]);
    expect(options.beforeBreadcrumb({ category: "console", message: "x" })).toBeNull();
    expect(options.beforeBreadcrumb({ category: "fetch" })).toEqual({ category: "fetch" });

    const error = new Error("boom");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    reportCaughtReactError(error, { componentStack: "\n    at Thread" });
    expect(sentry.captureReactException).toHaveBeenCalledWith(error, {
      componentStack: "\n    at Thread",
    });
    expect(consoleError).toHaveBeenCalledWith(error);
    consoleError.mockRestore();
  });
});
