import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  RealtimeFanout,
  SecretContext,
  SecretPutOptions,
  SecretStore,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { InfisicalSecretStoreOptions } from "./infisical-secret-store.js";
import { InfisicalSecretStore, isInfisicalRef } from "./infisical-secret-store.js";
import { SecretChanges } from "./secret-changes.js";
import { EncryptedSecretStore } from "./secrets.js";

export function secretStoreOptionsFromEnv(
  source: NodeJS.ProcessEnv,
): InfisicalSecretStoreOptions | undefined {
  const provider = source.SECRET_STORE?.trim() || "encrypted";
  // Fork alias: "database" was the fork's name for the encrypted store.
  if (provider === "encrypted" || provider === "database") return undefined;
  if (provider !== "infisical") throw new Error("Unsupported SECRET_STORE");
  // Fork aliases: prod (and spartacus-services) use INFISICAL_SITE_URL / INFISICAL_SECRET_PATH.
  // Compose injects empty strings for unset vars, so an empty upstream name falls through too.
  const required = (name: string, alias?: string) => {
    const value = source[name]?.trim() || (alias ? source[alias]?.trim() : undefined);
    if (!value) throw new Error(alias ? `Missing ${name} (or ${alias})` : `Missing ${name}`);
    return value;
  };
  const baseUrl = required("INFISICAL_URL", "INFISICAL_SITE_URL");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid INFISICAL_URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid INFISICAL_URL");
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback && source.INFISICAL_ALLOW_INSECURE_HTTP !== "true")
    throw new Error("INFISICAL_URL requires HTTPS or INFISICAL_ALLOW_INSECURE_HTTP=true");
  const folder = required("INFISICAL_FOLDER", "INFISICAL_SECRET_PATH");
  if (!folder.startsWith("/")) throw new Error("INFISICAL_FOLDER must start with /");
  return {
    baseUrl,
    clientId: required("INFISICAL_CLIENT_ID"),
    clientSecret: required("INFISICAL_CLIENT_SECRET"),
    projectId: required("INFISICAL_PROJECT_ID"),
    environment: required("INFISICAL_ENVIRONMENT"),
    folder,
    ...refreshTtl(source),
  };
}

/** Fork alias: INFISICAL_REFRESH_SECONDS was the fork's cache refresh period. */
function refreshTtl(source: NodeJS.ProcessEnv): { cacheTtlMs?: number } {
  const raw = source.INFISICAL_REFRESH_SECONDS?.trim();
  if (!raw) return {};
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("INFISICAL_REFRESH_SECONDS must be a positive number");
  return { cacheTtlMs: seconds * 1000 };
}

/** Fork: topic spartacus-services notifies (via pg_notify) after it writes a key. */
const LEGACY_CHANGED_TOPIC = "secret-store:changed";

/** Routing is private to the store; consumers only see opaque refs. */
export class ComposedSecretStore extends SecretChanges implements SecretStore {
  private readonly origin = randomUUID();
  private closed = false;
  private starting?: Promise<void>;
  private unsubscribe?: () => Promise<void>;
  private unsubscribeLegacy?: () => Promise<void>;
  private readonly subscriptions: Array<() => void> = [];
  constructor(
    private readonly encrypted: SecretStore,
    private readonly remote?: InfisicalSecretStore,
    private readonly realtime?: RealtimeFanout,
  ) {
    super();
    for (const store of remote ? [encrypted, remote] : [encrypted])
      this.subscriptions.push(store.onChange((ref) => this.changed(ref)));
  }
  describe() {
    return (this.remote ?? this.encrypted).describe();
  }
  start(): Promise<void> {
    this.starting ??= this.startOnce();
    return this.starting;
  }
  private async startOnce(): Promise<void> {
    await this.encrypted.start();
    await this.remote?.start();
    if (this.closed) return;
    if (this.realtime)
      this.unsubscribe = await this.realtime.subscribe("secret-store-change", (payload) => {
        try {
          const event = JSON.parse(payload);
          if (event.origin !== this.origin && typeof event.ref === "string") {
            if (this.remote && isInfisicalRef(event.ref)) this.remote.invalidate(event.ref);
            else this.changed(event.ref);
          }
        } catch {
          /* Ignore malformed notifications. */
        }
      });
    const remote = this.remote;
    if (this.realtime && remote && !this.closed)
      this.unsubscribeLegacy = await this.realtime.subscribe(LEGACY_CHANGED_TOPIC, () =>
        remote.dropCache(),
      );
  }
  private async publish(ref: string): Promise<void> {
    try {
      await this.realtime?.publish(
        "secret-store-change",
        JSON.stringify({ origin: this.origin, ref }),
      );
    } catch {
      getLogger().warn("Secret change notification failed");
    }
  }
  async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    const record = await (options.ephemeral || !this.remote ? this.encrypted : this.remote).put(
      value,
      context,
      options,
    );
    await this.publish(record.ref);
    return record;
  }
  load(ref: string, context: SecretContext): Promise<string> {
    return (isInfisicalRef(ref) && this.remote ? this.remote : this.encrypted).load(ref, context);
  }
  async delete(ref: string, context: SecretContext): Promise<void> {
    try {
      await (isInfisicalRef(ref) && this.remote ? this.remote : this.encrypted).delete(
        ref,
        context,
      );
    } finally {
      await this.publish(ref);
    }
  }

  redact(_value: string): string {
    return "[redacted]";
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.remote?.close();
    for (const stop of this.subscriptions) stop();
    await this.starting?.catch(() => undefined);
    try {
      await this.unsubscribe?.();
      await this.unsubscribeLegacy?.();
    } catch {
      getLogger().warn("Secret notification shutdown failed");
    }
    this.unsubscribe = undefined;
    this.unsubscribeLegacy = undefined;
    await this.encrypted.close();
    this.clearListeners();
  }
}

export function createSecretStore(
  encryptionKey: string,
  source: NodeJS.ProcessEnv = process.env,
  realtime?: RealtimeFanout,
): SecretStore {
  const options = secretStoreOptionsFromEnv(source);
  const encrypted = new EncryptedSecretStore(encryptionKey);
  return options || realtime
    ? new ComposedSecretStore(
        encrypted,
        options ? new InfisicalSecretStore(options) : undefined,
        realtime,
      )
    : encrypted;
}

export async function deleteSecretBestEffort(
  store: Pick<SecretStore, "delete">,
  ref: string,
  context: SecretContext,
): Promise<void> {
  try {
    await store.delete(ref, context);
  } catch {
    getLogger().warn("Secret deletion failed; retry cleanup before removing provider access");
  }
}
