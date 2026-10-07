import { randomBytes } from "node:crypto";
import type { AdapterContext, RealtimeFanout, SecretRecord } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, type SecretPutOptions } from "./secrets.js";

/** Rows written by this store hold `infisical:<key>` instead of ciphertext. */
export const INFISICAL_REFERENCE_PREFIX = "infisical:";
const CHANGED_TOPIC = "secret-store:changed";
const REQUEST_TIMEOUT_MS = 15_000;

export interface InfisicalSecretStoreOptions {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  /** Folder that holds only app-managed secrets, e.g. `/app`. */
  secretPath: string;
  refreshMs?: number;
  fetch?: typeof fetch;
}

export function isSecretReference(ciphertext: string): boolean {
  return ciphertext.startsWith(INFISICAL_REFERENCE_PREFIX);
}

/** Infisical key for a database record id; letters, digits and underscores only. */
export function infisicalSecretKey(recordId: string): string {
  return `SECRET_${recordId.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * Keeps secret values in an Infisical folder so operators manage them there.
 * Reads stay synchronous: the folder is mirrored in memory and refreshed on an
 * interval and whenever any process writes. Rows that still hold ciphertext
 * (written before the switch) keep decrypting with the deployment key.
 */
export class InfisicalSecretStore extends EncryptedSecretStore {
  private values = new Map<string, string>();
  private token: { value: string; expiresAt: number } | undefined;
  private refreshing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => Promise<void>) | undefined;
  private realtime: RealtimeFanout | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(
    encryptionKey: string,
    private readonly options: InfisicalSecretStoreOptions,
  ) {
    super(encryptionKey);
    this.fetchImpl = options.fetch ?? fetch;
  }

  override describe() {
    return {
      id: "infisical",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { rotate: true },
    };
  }

  /** Loads the folder (fails loudly when Infisical is unreachable) and starts syncing. */
  async start(realtime?: RealtimeFanout): Promise<void> {
    await this.refresh();
    this.realtime = realtime;
    this.unsubscribe = await realtime?.subscribe(CHANGED_TOPIC, () => this.refreshQuietly());
    this.timer = setInterval(() => this.refreshQuietly(), this.options.refreshMs ?? 30_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unsubscribe?.();
  }

  override async put(
    plaintext: string,
    context: AdapterContext,
    recordId = randomBytes(12).toString("hex"),
    options: SecretPutOptions = {},
  ): Promise<SecretRecord> {
    if (options.ephemeral) return super.put(plaintext, context, recordId);
    const key = infisicalSecretKey(recordId);
    await this.write(key, plaintext, options.label ?? context.operationId);
    this.values.set(key, plaintext);
    await this.realtime?.publish(CHANGED_TOPIC, key).catch(() => undefined);
    return { id: recordId, ciphertext: `${INFISICAL_REFERENCE_PREFIX}${key}` };
  }

  override load(ciphertext: string, recordId: string): string {
    if (!isSecretReference(ciphertext)) return super.load(ciphertext, recordId);
    const key = ciphertext.slice(INFISICAL_REFERENCE_PREFIX.length);
    // The reference is bound to its row, like the AAD on encrypted values.
    if (key !== infisicalSecretKey(recordId))
      throw new Error("Secret reference does not match its record");
    const value = this.values.get(key);
    if (value === undefined) {
      this.refreshQuietly();
      throw new Error("Secret is not available from Infisical");
    }
    return value;
  }

  /** Keys currently held in the folder, as of the last refresh. */
  keys(): string[] {
    return [...this.values.keys()];
  }

  async remove(key: string): Promise<void> {
    await this.request("DELETE", `/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
      workspaceId: this.options.projectId,
      environment: this.options.environment,
      secretPath: this.options.secretPath,
      type: "shared",
    });
    this.values.delete(key);
  }

  /** Creates the app folder when it is missing (used by setup and migration). */
  async ensureFolder(): Promise<void> {
    const segments = this.options.secretPath.split("/").filter(Boolean);
    let parent = "/";
    for (const name of segments) {
      const query = new URLSearchParams({
        workspaceId: this.options.projectId,
        environment: this.options.environment,
        path: parent,
      });
      const listed = (await this.request("GET", `/api/v1/folders?${query}`)) as {
        folders?: { name: string }[];
      };
      if (!listed.folders?.some((folder) => folder.name === name)) {
        await this.request("POST", "/api/v1/folders", {
          workspaceId: this.options.projectId,
          environment: this.options.environment,
          name,
          path: parent,
        });
      }
      parent = parent === "/" ? `/${name}` : `${parent}/${name}`;
    }
  }

  /** Reloads the folder; concurrent callers share one request. */
  refresh(): Promise<void> {
    this.refreshing ??= this.fetchAll().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private refreshQuietly() {
    // A failed refresh keeps the last good values; the next interval retries.
    this.refresh().catch(() => undefined);
  }

  private async fetchAll() {
    const query = new URLSearchParams({
      workspaceId: this.options.projectId,
      environment: this.options.environment,
      secretPath: this.options.secretPath,
    });
    const body = (await this.request("GET", `/api/v3/secrets/raw?${query}`)) as {
      secrets?: { secretKey: string; secretValue: string }[];
    };
    this.values = new Map(
      (body.secrets ?? []).map((secret) => [secret.secretKey, secret.secretValue]),
    );
  }

  private async write(key: string, value: string, comment: string) {
    const body = {
      workspaceId: this.options.projectId,
      environment: this.options.environment,
      secretPath: this.options.secretPath,
      secretValue: value,
      type: "shared",
    };
    const path = `/api/v3/secrets/raw/${encodeURIComponent(key)}`;
    const create = () => this.request("POST", path, { ...body, secretComment: comment });
    const update = () => this.request("PATCH", path, body);
    try {
      await (this.values.has(key) ? update() : create());
    } catch (error) {
      if (!(error instanceof InfisicalRequestError)) throw error;
      // The mirror can be stale: another process created the key, or an operator deleted it.
      if (error.status === 400) await update();
      else if (error.status === 404) await create();
      else throw error;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.fetchImpl(
      new URL("/api/v1/auth/universal-auth/login", this.options.siteUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: this.options.clientId,
          clientSecret: this.options.clientSecret,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new InfisicalRequestError("login", response.status);
    const body = (await response.json()) as { accessToken: string; expiresIn: number };
    this.token = { value: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 };
    return body.accessToken;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.options.siteUrl), {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 && !retried) {
      this.token = undefined;
      return this.request(method, path, body, true);
    }
    // Response bodies can echo request values, so errors carry only the status.
    if (!response.ok)
      throw new InfisicalRequestError(`${method} ${path.split("?")[0]}`, response.status);
    return response.json();
  }
}

export class InfisicalRequestError extends Error {
  constructor(
    operation: string,
    readonly status: number,
  ) {
    super(`Infisical ${operation} failed with HTTP ${status}`);
  }
}

/**
 * Builds the deployment's secret store. `SECRET_STORE=infisical` keeps values in
 * Infisical; anything else keeps the encrypted database store.
 */
export async function createSecretStore(
  source: Record<string, string | undefined>,
  encryptionKey: string,
  realtime?: RealtimeFanout,
): Promise<EncryptedSecretStore> {
  if ((source.SECRET_STORE ?? "database") !== "infisical")
    return new EncryptedSecretStore(encryptionKey);
  const store = new InfisicalSecretStore(encryptionKey, infisicalOptionsFromEnv(source));
  await store.start(realtime);
  return store;
}

export function infisicalOptionsFromEnv(
  source: Record<string, string | undefined>,
): InfisicalSecretStoreOptions {
  const required = (name: string) => {
    const value = source[name]?.trim();
    if (!value) throw new Error(`${name} is required when SECRET_STORE=infisical`);
    return value;
  };
  const refreshSeconds = Number(source.INFISICAL_REFRESH_SECONDS ?? 30);
  return {
    siteUrl: required("INFISICAL_SITE_URL"),
    clientId: required("INFISICAL_CLIENT_ID"),
    clientSecret: required("INFISICAL_CLIENT_SECRET"),
    projectId: required("INFISICAL_PROJECT_ID"),
    environment: required("INFISICAL_ENVIRONMENT"),
    secretPath: required("INFISICAL_SECRET_PATH"),
    refreshMs:
      Number.isFinite(refreshSeconds) && refreshSeconds >= 5 ? refreshSeconds * 1000 : 30_000,
  };
}
