import type * as SentryReact from "@sentry/react";
import type { ErrorInfo } from "react";

// Browser error reporting. The API says at runtime whether it is on, so one web build serves every
// deployment; the SDK is only downloaded when it is.

interface MonitoringConfig {
  dsn: string | null;
  environment?: string | null;
  release?: string | null;
  tunnel?: string;
}

let sentry: typeof SentryReact | undefined;

export async function startMonitoring(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let config: MonitoringConfig;
  try {
    const response = await fetchImpl("/api/monitoring/config");
    if (!response.ok) return false;
    config = (await response.json()) as MonitoringConfig;
  } catch {
    // The API is unreachable; the app shows its own connection error.
    return false;
  }
  if (!config.dsn) return false;
  let Sentry: typeof SentryReact;
  try {
    // A stale chunk after a deploy or a network failure must not surface as an unhandled rejection.
    Sentry = await import("@sentry/react");
    Sentry.init({
      dsn: config.dsn,
      environment: config.environment ?? undefined,
      release: config.release ?? undefined,
      tunnel: config.tunnel,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      // Sessions are not used by the collector, and console output can carry user content.
      integrations: (defaults) =>
        defaults.filter((integration) => integration.name !== "BrowserSession"),
      beforeBreadcrumb: (breadcrumb) => (breadcrumb.category === "console" ? null : breadcrumb),
    });
  } catch (error) {
    console.warn("Browser error reporting failed to start", error);
    return false;
  }
  sentry = Sentry;
  return true;
}

/**
 * React root `onCaughtError`: report errors an error boundary rendered a fallback for. Uncaught
 * render errors already reach `window.onerror`, where the SDK picks them up.
 */
export function reportCaughtReactError(error: unknown, errorInfo: ErrorInfo): void {
  sentry?.captureReactException(error, errorInfo);
  console.error(error);
}
