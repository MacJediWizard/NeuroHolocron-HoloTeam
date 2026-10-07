import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSecretsToInfisical } from "./infisical-secret-migration.js";
import {
  createSecretStore,
  InfisicalSecretStore,
  type InfisicalSecretStoreOptions,
  infisicalSecretKey,
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
      return json({
        secrets: [...this.secrets].map(([secretKey, { value }]) => ({
          secretKey,
          secretValue: value,
        })),
      });
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
      this.secrets.delete(key);
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

const stores: InfisicalSecretStore[] = [];
async function started(fake: FakeInfisical, realtime?: InMemoryRealtimeFanout) {
  const store = new InfisicalSecretStore(KEY, options(fake));
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
    expect(stored).toEqual({ id: "rec1", ciphertext: "infisical:SECRET_rec1" });
    expect(fake.secrets.get("SECRET_rec1")).toEqual({ value: "sk-live-value", comment: "op" });
    expect(store.load(stored.ciphertext, "rec1")).toBe("sk-live-value");
  });

  it("binds a reference to its record", async () => {
    const store = await started(new FakeInfisical());
    const stored = await store.put("value", context, "rec1");
    expect(() => store.load(stored.ciphertext, "rec2")).toThrow("does not match");
  });

  it("updates an existing key instead of creating it again", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    await store.put("first", context, "rec1");
    await store.put("second", context, "rec1");
    expect(fake.secrets.get("SECRET_rec1")?.value).toBe("second");
    expect(fake.requests.filter((r) => r.startsWith("PATCH"))).toHaveLength(1);
  });

  it("recreates a key an operator deleted in Infisical", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    await store.put("first", context, "rec1");
    fake.secrets.delete("SECRET_rec1");
    await store.put("second", context, "rec1");
    expect(fake.secrets.get("SECRET_rec1")?.value).toBe("second");
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

  it("picks up values edited in Infisical on refresh", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    const stored = await store.put("before", context, "rec1");
    fake.secrets.set("SECRET_rec1", { value: "after" });
    await store.refresh();
    expect(store.load(stored.ciphertext, "rec1")).toBe("after");
  });

  it("tells other processes to refresh after a write", async () => {
    const fake = new FakeInfisical();
    const realtime = new InMemoryRealtimeFanout();
    const writer = await started(fake, realtime);
    const reader = await started(fake, realtime);
    const stored = await writer.put("shared", context, "rec1");
    await reader.refresh();
    expect(reader.load(stored.ciphertext, "rec1")).toBe("shared");
  });

  it("fails clearly when a referenced value is missing", async () => {
    const store = await started(new FakeInfisical());
    expect(() => store.load("infisical:SECRET_rec1", "rec1")).toThrow("not available");
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
    const store = await started(fake);
    fake.fetch = async () => json({ message: "echo sk-live-value" }, 500);
    const failing = new InfisicalSecretStore(KEY, { ...options(fake), fetch: fake.fetch });
    await expect(failing.refresh()).rejects.toThrow("HTTP 500");
    await expect(failing.refresh()).rejects.not.toThrow("sk-live");
    expect(store).toBeDefined();
  });

  it("removes keys", async () => {
    const fake = new FakeInfisical();
    const store = await started(fake);
    await store.put("value", context, "rec1");
    await store.remove("SECRET_rec1");
    expect(fake.secrets.size).toBe(0);
    expect(store.keys()).toEqual([]);
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
    expect(rows.secrets[0]?.ciphertext).toBe("infisical:SECRET_s1");
    expect(rows.providers[0]?.ciphertext).toBe("infisical:SECRET_integration_provider_composio");
    expect(fake.secrets.get("SECRET_s2")?.comment).toBe("MCP server Mail");
    expect(fake.secrets.get("SECRET_b1")?.comment).toBe("Operator credential site_login");
    expect(store.load(rows.botSecrets[0]?.ciphertext ?? "", "b1")).toBe("pw");
    expect(store.load(rows.providers[0]?.ciphertext ?? "", "integration-provider:composio")).toBe(
      '{"provider":"composio"}',
    );
    const again = await migrateSecretsToInfisical(prisma, store);
    expect(again.migrated).toEqual([]);
    expect(again.alreadyReferenced).toBe(4);
  });

  it("prunes only keys no row references", async () => {
    const { prisma, fake, store } = await setup();
    await migrateSecretsToInfisical(prisma, store);
    fake.secrets.set("SECRET_gone", { value: "x" });
    fake.secrets.set("OPERATOR_NOTE", { value: "x" });
    const report = await migrateSecretsToInfisical(prisma, store, { prune: true });
    expect(report.orphaned).toEqual(["SECRET_gone"]);
    expect(fake.secrets.has("SECRET_gone")).toBe(false);
    expect(fake.secrets.has("OPERATOR_NOTE")).toBe(true);
  });
});
