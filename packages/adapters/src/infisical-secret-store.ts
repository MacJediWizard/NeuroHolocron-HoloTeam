import { randomBytes } from "node:crypto";
import type { AdapterContext, RealtimeFanout, SecretRecord } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { SecretPutOptions } from "./secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

/** Rows written by this store hold `infisical:<key>` instead of ciphertext. */
export const INFISICAL_REFERENCE_PREFIX = "infisical:";
const CHANGED_TOPIC = "secret-store:changed";
const REQUEST_TIMEOUT_MS = 15_000;
/** Unreferenced keys younger than this may belong to a save that has not committed yet. */
export const UNREFERENCED_KEY_GRACE_MS = 60 * 60 * 1000;
const VERSION_SUFFIX = /^__v([0-9a-z]+)_[0-9a-f]+$/;

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

export interface InfisicalStartOptions {
  /** Keys rows currently reference; enables the periodic removal of unreferenced keys. */
  referencedKeys?: () => Promise<Iterable<string>>;
  sweepMs?: number;
}

export function isSecretReference(ciphertext: string): boolean {
  return ciphertext.startsWith(INFISICAL_REFERENCE_PREFIX);
}

/** Infisical key prefix for a database record id; letters, digits and underscores only. */
export function infisicalSecretKey(recordId: string): string {
  return `SECRET_${recordId.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** When a versioned key was written; keys from before versioning have no time. */
export function infisicalKeyWrittenAt(key: string): number | undefined {
  const match = /__v([0-9a-z]+)_[0-9a-f]+$/.exec(key);
  return match?.[1] ? Number.parseInt(match[1], 36) : undefined;
}

function keyBelongsTo(key: string, recordId: string): boolean {
  const base = infisicalSecretKey(recordId);
  return key === base || (key.startsWith(base) && VERSION_SUFFIX.test(key.slice(base.length)));
}

/**
 * Keeps secret values in an Infisical folder so operators manage them there.
 * Reads stay synchronous: the folder is mirrored in memory and refreshed on an
 * interval and whenever any process writes. Rows that still hold ciphertext
 * (written before the switch) keep decrypting with the deployment key.
 *
 * Every save writes a new key, so a save that fails or loses a race never
 * changes the value a committed row references. Keys no row references are
 * removed once they are older than UNREFERENCED_KEY_GRACE_MS.
 */
export class InfisicalSecretStore extends EncryptedSecretStore {
  private values = new Map<string, string>();
  /** Bumped per key whenever its value changes, so callers can tell a rotation. */
  private revisions = new Map<string, number>();
  private lastRevision = 0;
  /** Local writes and removals, kept until a refresh that started after them lands. */
  private localChanges = new Map<string, { value: string | undefined; sequence: number }>();
  private sequence = 0;
  private token: { value: string; expiresAt: number } | undefined;
  private refreshing: Promise<void> | undefined;
  private queuedRefresh: Promise<void> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubscribe: (() => Promise<void>) | undefined;
  private realtime: RealtimeFanout | undefined;
  private refreshFailing = false;
  private closed = false;
  private readonly fetchImpl: typeof fetch;
  /** Time of the last successful folder read, or undefined before the first. */
  lastRefreshedAt: Date | undefined;

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
  async start(realtime?: RealtimeFanout, options: InfisicalStartOptions = {}): Promise<void> {
    await this.refresh();
    this.realtime = realtime;
    this.unsubscribe = await realtime?.subscribe(CHANGED_TOPIC, () => this.refreshQuietly());
    this.every(this.options.refreshMs ?? 30_000, () => this.refreshQuietly());
    const { referencedKeys } = options;
    if (referencedKeys) {
      this.every(options.sweepMs ?? UNREFERENCED_KEY_GRACE_MS, () => {
        void referencedKeys()
          .then((keys) => this.sweep(keys))
          .catch((error: unknown) => {
            getLogger().warn(
              `Infisical cleanup of unreferenced keys failed: ${errorSummary(error)}`,
            );
          });
      });
    }
  }

  override async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  override async put(
    plaintext: string,
    context: AdapterContext,
    recordId = randomBytes(12).toString("hex"),
    options: SecretPutOptions = {},
  ): Promise<SecretRecord> {
    if (options.ephemeral) return super.put(plaintext, context, recordId);
    const key = `${infisicalSecretKey(recordId)}__v${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    await this.request("POST", this.secretPath(key), {
      ...this.scope(),
      secretValue: plaintext,
      secretComment: options.label ?? context.operationId,
    });
    this.changeLocally(key, plaintext);
    await this.realtime?.publish(CHANGED_TOPIC, key).catch(() => undefined);
    return { id: recordId, ciphertext: `${INFISICAL_REFERENCE_PREFIX}${key}` };
  }

  override load(ciphertext: string, recordId: string): string {
    if (!isSecretReference(ciphertext)) return super.load(ciphertext, recordId);
    const value = this.values.get(this.keyFor(ciphertext, recordId));
    if (value === undefined) {
      // Another process may have just written it; the next read can succeed.
      this.refreshQuietly();
      throw new Error("Secret is not available from Infisical yet");
    }
    return value;
  }

  /** Like load, but waits for a refresh when the value is not mirrored yet. */
  override async loadAsync(ciphertext: string, recordId: string): Promise<string> {
    if (!isSecretReference(ciphertext)) return super.loadAsync(ciphertext, recordId);
    if (!this.values.has(this.keyFor(ciphertext, recordId))) await this.refresh();
    return this.load(ciphertext, recordId);
  }

  /** Changes when the referenced value changes, including edits made in Infisical. */
  override revision(ciphertext: string, recordId: string): string {
    if (!isSecretReference(ciphertext)) return super.revision(ciphertext, recordId);
    const key = this.keyFor(ciphertext, recordId);
    return `${ciphertext}#${this.values.has(key) ? (this.revisions.get(key) ?? 0) : "missing"}`;
  }

  /** Keys currently held in the folder, as of the last refresh. */
  keys(): string[] {
    return [...this.values.keys()];
  }

  async remove(key: string): Promise<void> {
    try {
      await this.request("DELETE", this.secretPath(key), { ...this.scope(), type: "shared" });
    } catch (error) {
      if (!(error instanceof InfisicalRequestError && error.status === 404)) throw error;
    }
    this.changeLocally(key, undefined);
  }

  /**
   * Removes app keys that no row references and that are past the grace period,
   * so values from replaced, failed or deleted saves do not accumulate.
   */
  async sweep(referencedKeys: Iterable<string>, now = Date.now()): Promise<string[]> {
    const referenced = new Set(referencedKeys);
    const removed: string[] = [];
    for (const key of this.keys()) {
      if (!key.startsWith("SECRET_") || referenced.has(key)) continue;
      const writtenAt = infisicalKeyWrittenAt(key);
      if (writtenAt !== undefined && now - writtenAt < UNREFERENCED_KEY_GRACE_MS) continue;
      await this.remove(key);
      removed.push(key);
    }
    return removed;
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

  /**
   * Reloads the folder. A call made while a read is in flight waits for one more
   * read, since the one in flight may predate the change it was called for.
   */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.queuedRefresh ??= this.refreshing
        .catch(() => undefined)
        .then(() => {
          this.queuedRefresh = undefined;
          return this.refresh();
        });
      return this.queuedRefresh;
    }
    this.refreshing = this.fetchAll().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private refreshQuietly() {
    if (this.closed) return;
    // A failed refresh keeps the last good values; the next interval retries.
    this.refresh().then(
      () => {
        if (!this.refreshFailing) return;
        this.refreshFailing = false;
        getLogger().info("Infisical secret refresh recovered");
      },
      (error: unknown) => {
        if (this.refreshFailing) return;
        this.refreshFailing = true;
        getLogger().warn(
          `Infisical secret refresh failed; serving values from ${this.lastRefreshedAt?.toISOString() ?? "startup"}: ${errorSummary(error)}`,
        );
      },
    );
  }

  private async fetchAll() {
    const startedAt = this.sequence;
    const query = new URLSearchParams({
      ...this.scope(),
      // Imported secrets belong to other folders; the app owns only its own.
      include_imports: "false",
    });
    const body = (await this.request("GET", `/api/v3/secrets/raw?${query}`)) as {
      secrets?: { secretKey: string; secretValue: string }[];
    };
    const next = new Map(
      (body.secrets ?? []).map((secret) => [secret.secretKey, secret.secretValue]),
    );
    // Changes made here after the read began may be missing from it.
    for (const [key, change] of this.localChanges) {
      if (change.sequence <= startedAt) this.localChanges.delete(key);
      else if (change.value === undefined) next.delete(key);
      else next.set(key, change.value);
    }
    for (const [key, value] of next) {
      if (this.values.get(key) !== value) this.revisions.set(key, ++this.lastRevision);
    }
    this.values = next;
    this.lastRefreshedAt = new Date();
  }

  private changeLocally(key: string, value: string | undefined) {
    this.localChanges.set(key, { value, sequence: ++this.sequence });
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
      this.revisions.set(key, ++this.lastRevision);
    }
  }

  private keyFor(ciphertext: string, recordId: string): string {
    const key = ciphertext.slice(INFISICAL_REFERENCE_PREFIX.length);
    // The reference is bound to its row, like the AAD on encrypted values.
    if (!keyBelongsTo(key, recordId)) throw new Error("Secret reference does not match its record");
    return key;
  }

  private scope() {
    return {
      workspaceId: this.options.projectId,
      environment: this.options.environment,
      secretPath: this.options.secretPath,
    };
  }

  private secretPath(key: string) {
    return `/api/v3/secrets/raw/${encodeURIComponent(key)}`;
  }

  private every(ms: number, task: () => void) {
    const timer = setInterval(task, ms);
    timer.unref?.();
    this.timers.push(timer);
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

/** Errors from this store carry no values; anything else is reduced to its type. */
function errorSummary(error: unknown): string {
  return error instanceof InfisicalRequestError
    ? error.message
    : error instanceof Error
      ? error.name
      : "unknown error";
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
  options?: InfisicalStartOptions,
): Promise<EncryptedSecretStore> {
  if ((source.SECRET_STORE ?? "database") !== "infisical")
    return new EncryptedSecretStore(encryptionKey);
  const store = new InfisicalSecretStore(encryptionKey, infisicalOptionsFromEnv(source));
  await store.start(realtime, options);
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
