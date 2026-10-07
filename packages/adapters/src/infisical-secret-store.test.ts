import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateSecretsToInfisical } from "./infisical-secret-migration.js";
import type { InfisicalSecretStoreOptions } from "./infisical-secret-store.js";
import {
  createSecretStore,
  InfisicalSecretStore,
  infisicalSecretKey,
  UNREFERENCED_KEY_GRACE_MS,
} from "./infisical-secret-store.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { EncryptedSecretStore } from "./secrets.js";

const KEY = "test-encryption-key-with-enough-length";
const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

/** In-memory stand-in for the Infisical endpoints the store calls. */
class FakeInfisical {
  secrets = new Map<string, { value: string; comment?: string }>();
  logins = 0;
  rejectNextToken = false;
  requests: string[] = [];
  /** Holds folder reads until released, to interleave them with writes. */
  holdReads: (() => void)[] | undefined;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      if (body.clientSecret !== "client-secret") return json({ message: "denied" }, 401);
      this.logins += 1;
      return json({ accessToken: `token-${this.logins}`, expiresIn: 3600 });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (this.rejectNextToken) {
      this.rejectNextToken = false;
      return json({ message: "expired" }, 401);
    }
    if (auth !== `Bearer token-${this.logins}`) return json({ message: "denied" }, 401);
    if (url.pathname === "/api/v3/secrets/raw" && method === "GET") {
      if (url.searchParams.get("include_imports") !== "false") return json({}, 400);
      const snapshot = [...this.secrets].map(([secretKey, { value }]) => ({
        secretKey,
        secretValue: value,
      }));
      if (this.holdReads) await new Promise<void>((release) => this.holdReads?.push(release));
      return json({ secrets: snapshot });
    }
    const key = decodeURIComponent(url.pathname.replace("/api/v3/secrets/raw/", ""));
    if (method === "POST") {
      if (this.secrets.has(key)) return json({ message: `secret ${body.secretValue} exists` }, 400);
      this.secrets.set(key, { value: body.secretValue, comment: body.secretComment });
      return json({});
    }
    if (method === "PATCH") {
      const existing = this.secrets.get(key);
      if (!existing) return json({}, 404);
      existing.value = body.secretValue;
      return json({});
    }
    if (method === "DELETE") {
      if (body.secretPath !== "/app") return json({}, 422);
      if (!this.secrets.delete(key)) return json({}, 404);
      return json({});
    }
    return json({}, 404);
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(fake: FakeInfisical): InfisicalSecretStoreOptions {
  return {
    siteUrl: "https://infisical.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    projectId: "project",
    environment: "prod",
    secretPath: "/app",
    fetch: fake.fetch,
  };
}

const keyOf = (stored: { ciphertext: string }) => stored.ciphertext.slice("infisical:".length);

const stores: InfisicalSecretStore[] = [];
async function started(
  fake: FakeInfisical,
  realtime?: InMemoryRealtimeFanout,
  overrides: Partial<InfisicalSecretStoreOptions> = {},
) {
  const store = new InfisicalSecretStore(KEY, { ...options(fake), ...overrides });
  stores.push(store);
  await store.start(realtime);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("InfisicalSecretStore", () => {
  it("writes values to Infisical and keeps only a reference in the row", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const stored = await store.put("sk-live-value", context, "rec1");
    expect(stored.id).toBe("rec1");
    expect(stored.ciphertext).toMatch(/^infisical:SECRET_rec1__v[0-9a-z]+_[0-9a-f]+$/);
    expect(fake.secrets.get(keyOf(stored))).toEqual({ value: "sk-live-value", comment: "op" });
    expect(store.load(stored.ciphertext, "rec1")).toBe("sk-live-value");
  });

  it("binds a reference to its record", async () => {
    const store = await started(new FakeInfisical());
    const stored = await store.put("value", context, "rec1");
    expect(() => store.load(stored.ciphertext, "rec2")).toThrow("does not match");
    expect(() => store.load(stored.ciphertext.replace("rec1", "rec10"), "rec1")).toThrow(
      "does not match",
    );
  });

  it("keeps the committed value when a replacement is never committed", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const committed = await store.put("first", context, "rec1");
    // The caller's database write fails after this, so the row keeps `committed`.
    const abandoned = await store.put("second", context, "rec1");
    expect(keyOf(abandoned)).not.toBe(keyOf(committed));
    expect(fake.secrets.get(keyOf(committed))?.value).toBe("first");
    expect(store.load(committed.ciphertext, "rec1")).toBe("first");
  });

  it("still reads keys written before saves were versioned", async () => {
    const fake = new FakeInfisical();
    fake.secrets.set("SECRET_rec1", { value: "legacy" });
    const store = await started(fake);
    expect(store.load("infisical:SECRET_rec1", "rec1")).toBe("legacy");
  });

  it("still reads rows encrypted before the switch", async () => {
    const legacy = await new EncryptedSecretStore(KEY).put("old-value", context, "rec1");
    const store = await started(new FakeInfisical());
    expect(store.load(legacy.ciphertext, "rec1")).toBe("old-value");
  });

  it("keeps ephemeral values encrypted locally", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const stored = await store.put("123456", context, "otp", { ephemeral: true });
    expect(stored.ciphertext.startsWith("v2:")).toBe(true);
    expect(fake.secrets.size).toBe(0);
    expect(store.load(stored.ciphertext, "otp")).toBe("123456");
  });

  it("picks up values edited in Infisical on refresh and reports a new revision", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const stored = await store.put("before", context, "rec1");
    const before = store.revision(stored.ciphertext, "rec1");
    await store.refresh();
    expect(store.revision(stored.ciphertext, "rec1")).toBe(before);
    fake.secrets.set(keyOf(stored), { value: "after" });
    await store.refresh();
    expect(store.load(stored.ciphertext, "rec1")).toBe("after");
    expect(store.revision(stored.ciphertext, "rec1")).not.toBe(before);
  });

  it("does not let an older folder read undo a newer write", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const old = await store.put("old", context, "rec1");
    fake.holdReads = [];
    const reading = store.refresh();
    await vi.waitFor(() => expect(fake.holdReads).toHaveLength(1));
    const fresh = await store.put("new", context, "rec2");
    await store.remove(keyOf(old));
    for (const release of fake.holdReads.splice(0)) release();
    fake.holdReads = undefined;
    await reading;
    expect(store.load(fresh.ciphertext, "rec2")).toBe("new");
    expect(store.keys()).toEqual([keyOf(fresh)]);
  });

  it("reads again when asked to refresh while a read is in flight", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    fake.holdReads = [];
    const first = store.refresh();
    await vi.waitFor(() => expect(fake.holdReads).toHaveLength(1));
    // Another process writes after the in-flight read took its snapshot.
    fake.secrets.set("SECRET_rec1", { value: "remote" });
    const second = store.refresh();
    fake.holdReads.splice(0)[0]?.();
    await first;
    await vi.waitFor(() => expect(fake.holdReads).toHaveLength(1));
    fake.holdReads.splice(0)[0]?.();
    fake.holdReads = undefined;
    await second;
    expect(store.load("infisical:SECRET_rec1", "rec1")).toBe("remote");
  });

  it("tells other processes to refresh after a write", async () => {
    const fake = new FakeInfisical();
    const realtime = new InMemoryRealtimeFanout();
    const writer = await started(fake, realtime);
    const reader = await started(fake, realtime);
    const stored = await writer.put("shared", context, "rec1");
    await vi.waitFor(() => expect(reader.load(stored.ciphertext, "rec1")).toBe("shared"));
  });

  it("fails clearly when a referenced value is missing", async () => {
    const store = await started(new FakeInfisical());
    expect(() => store.load("infisical:SECRET_rec1", "rec1")).toThrow("not available");
  });

  it("waits for a refresh before failing an async read", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    fake.secrets.set("SECRET_rec1", { value: "written elsewhere" });
    await expect(store.loadAsync("infisical:SECRET_rec1", "rec1")).resolves.toBe(
      "written elsewhere",
    );
  });

  it("logs in again when the access token is rejected", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    fake.rejectNextToken = true;
    await store.put("value", context, "rec1");
    expect(fake.logins).toBe(2);
  });

  it("keeps response bodies out of errors", async () => {
    const fake = new FakeInfisical();
    fake.fetch = async () => json({ message: "echo sk-live-value" }, 500);
    const failing = new InfisicalSecretStore(KEY, options(fake));
    await expect(failing.refresh()).rejects.toThrow("HTTP 500");
    await expect(failing.refresh()).rejects.not.toThrow("sk-live");
  });

  it("logs a failed background refresh once and keeps the last values", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    installLogger({ warn, info, error: vi.fn(), debug: vi.fn() } as never);
    const fake = new FakeInfisical();
    const realtime = new InMemoryRealtimeFanout();
    let failing = false;
    const store = await started(fake, realtime, {
      fetch: (input, init) =>
        failing ? Promise.resolve(json({ message: "echo kept" }, 503)) : fake.fetch(input, init),
    });
    const stored = await store.put("kept", context, "rec1");
    failing = true;
    await realtime.publish("secret-store:changed", "x");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await realtime.publish("secret-store:changed", "x");
    await store.refresh().catch(() => undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("HTTP 503");
    expect(warn.mock.calls[0]?.[0]).not.toContain("kept");
    expect(store.load(stored.ciphertext, "rec1")).toBe("kept");
    expect(store.lastRefreshedAt).toBeInstanceOf(Date);
    failing = false;
    await realtime.publish("secret-store:changed", "x");
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith("Infisical secret refresh recovered"));
  });

  it("stops polling when closed", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake, undefined, { refreshMs: 5 });
    await vi.waitFor(() =>
      expect(fake.requests.filter((r) => r === "GET /api/v3/secrets/raw").length).toBeGreaterThan(
        1,
      ),
    );
    await store.close();
    const reads = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.requests.length).toBe(reads);
  });

  it("removes keys, including ones already gone", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const stored = await store.put("value", context, "rec1");
    await store.remove(keyOf(stored));
    await store.remove(keyOf(stored));
    expect(fake.secrets.size).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  it("sweeps only unreferenced app keys past the grace period", async () => {
    const fake = new FakeInfisical();
    fake.secrets.set("SECRET_legacy", { value: "x" });
    fake.secrets.set("OPERATOR_NOTE", { value: "x" });
    const store = await started(fake);
    const referenced = await store.put("in use", context, "rec1");
    const pending = await store.put("committing", context, "rec2");
    expect(await store.sweep([keyOf(referenced)])).toEqual(["SECRET_legacy"]);
    expect(fake.secrets.has(keyOf(pending))).toBe(true);
    const later = Date.now() + UNREFERENCED_KEY_GRACE_MS + 1;
    expect(await store.sweep([keyOf(referenced)], later)).toEqual([keyOf(pending)]);
    expect([...fake.secrets.keys()].sort()).toEqual(["OPERATOR_NOTE", keyOf(referenced)].sort());
  });

  it("maps record ids to Infisical-safe keys", () => {
    expect(infisicalSecretKey("integration-provider:composio")).toBe(
      "SECRET_integration_provider_composio",
    );
  });
});

describe("createSecretStore", () => {
  it("keeps the database store by default", async () => {
    const store = await createSecretStore({}, KEY);
    expect(store).toBeInstanceOf(EncryptedSecretStore);
    expect(store).not.toBeInstanceOf(InfisicalSecretStore);
  });

  it("requires the Infisical settings when selected", async () => {
    await expect(createSecretStore({ SECRET_STORE: "infisical" }, KEY)).rejects.toThrow(
      "INFISICAL_SITE_URL is required",
    );
  });
});

describe("migrateSecretsToInfisical", () => {
  async function setup() {
    const local = new EncryptedSecretStore(KEY);
    const seal = async (value: string, id: string) =>
      (await local.put(value, context, id)).ciphertext;
    const rows = {
      secrets: [
        {
          id: "s1",
          kind: "model",
          ciphertext: await seal("model-key", "s1"),
          spaceId: "space",
          userId: "u",
          mcpServers: [],
          agentSecret: null,
        },
        {
          id: "s2",
          kind: "mcp",
          ciphertext: await seal("{}", "s2"),
          spaceId: "space",
          userId: "u",
          mcpServers: [{ name: "Mail" }],
          agentSecret: null,
        },
        {
          id: "s3",
          kind: "model",
          ciphertext: "not-decryptable",
          spaceId: "space",
          userId: "u",
          mcpServers: [],
          agentSecret: null,
        },
      ],
      botSecrets: [
        {
          id: "b1",
          name: "site_login",
          ciphertext: await seal("pw", "b1"),
          spaceId: "space",
          userId: "u",
          bot: { name: "Operator" },
        },
      ],
      providers: [
        {
          id: "composio",
          ciphertext: await seal('{"provider":"composio"}', "integration-provider:composio"),
        },
      ],
    };
    const update =
      (list: { id: string; ciphertext: string }[]) =>
      async ({
        where,
        data,
      }: {
        where: { id: string; ciphertext: string };
        data: { ciphertext: string };
      }) => {
        const row = list.find((r) => r.id === where.id && r.ciphertext === where.ciphertext);
        if (row) row.ciphertext = data.ciphertext;
        return { count: row ? 1 : 0 };
      };
    const prisma = {
      secret: { findMany: async () => rows.secrets, updateMany: update(rows.secrets) },
      botSecret: { findMany: async () => rows.botSecrets, updateMany: update(rows.botSecrets) },
      integrationProviderConfig: {
        findMany: async () => rows.providers,
        updateMany: update(rows.providers),
      },
    } as unknown as PrismaClient;
    const fake = new FakeInfisical();
    const store = new InfisicalSecretStore(KEY, options(fake));
    stores.push(store);
    return { rows, prisma, fake, store };
  }

  it("reports without writing on a dry run", async () => {
    const { prisma, fake, store } = await setup();
    const report = await migrateSecretsToInfisical(prisma, store, { dryRun: true });
    expect(report.migrated).toHaveLength(4);
    expect(report.unreadable).toEqual(["secrets:s3"]);
    expect(fake.secrets.size).toBe(0);
  });

  it("moves every readable value, labels it, and is safe to rerun", async () => {
    const { rows, prisma, fake, store } = await setup();
    const report = await migrateSecretsToInfisical(prisma, store);
    expect(report.migrated).toHaveLength(4);
    expect(rows.secrets[0]?.ciphertext).toMatch(/^infisical:SECRET_s1__v/);
    expect(rows.providers[0]?.ciphertext).toMatch(
      /^infisical:SECRET_integration_provider_composio__v/,
    );
    expect(fake.secrets.get(keyOf(rows.secrets[1] ?? { ciphertext: "" }))?.comment).toBe(
      "MCP server Mail",
    );
    expect(fake.secrets.get(keyOf(rows.botSecrets[0] ?? { ciphertext: "" }))?.comment).toBe(
      "Operator credential site_login",
    );
    expect(store.load(rows.botSecrets[0]?.ciphertext ?? "", "b1")).toBe("pw");
    expect(store.load(rows.providers[0]?.ciphertext ?? "", "integration-provider:composio")).toBe(
      '{"provider":"composio"}',
    );
    const again = await migrateSecretsToInfisical(prisma, store);
    expect(again.migrated).toEqual([]);
    expect(again.alreadyReferenced).toBe(4);
    expect(again.orphaned).toEqual([]);
  });

  it("leaves a credential saved during the migration untouched", async () => {
    const { rows, prisma, fake, store } = await setup();
    const runtime = await store.put("newer", context, "b1");
    const botSecret = prisma.botSecret as unknown as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    const update = botSecret.updateMany;
    // The app saves a replacement after the migration read the old row.
    botSecret.updateMany = async (args) => {
      const row = rows.botSecrets[0];
      if (row) row.ciphertext = runtime.ciphertext;
      return update(args);
    };
    await migrateSecretsToInfisical(prisma, store);
    expect(rows.botSecrets[0]?.ciphertext).toBe(runtime.ciphertext);
    expect(store.load(runtime.ciphertext, "b1")).toBe("newer");
    // The copy that lost the race is removed instead of left behind.
    expect([...fake.secrets.keys()].filter((key) => key.startsWith("SECRET_b1"))).toEqual([
      keyOf(runtime),
    ]);
  });

  it("prunes only unreferenced keys past the grace period", async () => {
    const { prisma, fake, store } = await setup();
    await migrateSecretsToInfisical(prisma, store);
    fake.secrets.set("SECRET_gone", { value: "x" });
    fake.secrets.set("OPERATOR_NOTE", { value: "x" });
    const pending = await store.put("committing", context, "s9");
    const report = await migrateSecretsToInfisical(prisma, store, { prune: true });
    expect(report.orphaned.sort()).toEqual(["SECRET_gone", keyOf(pending)].sort());
    expect(report.pruned).toBe(1);
    expect(fake.secrets.has("SECRET_gone")).toBe(false);
    expect(fake.secrets.has(keyOf(pending))).toBe(true);
    expect(fake.secrets.has("OPERATOR_NOTE")).toBe(true);
  });
});
