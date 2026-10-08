// Fork compat tests: Legiara and spartacus-services share Infisical keys in the fork format
// `infisical:SECRET_<recordId with non-alphanumerics as _>[__v<base36>_<hex>]`.
import type { AdapterContext, RealtimeFanout } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import { InfisicalSecretStore, isInfisicalRef } from "./infisical-secret-store.js";
import type { SecretMigrationRepository, SecretMigrationRow } from "./secret-migration.js";
import { migrateSecrets } from "./secret-migration.js";
import {
  ComposedSecretStore,
  createSecretStore,
  secretStoreOptionsFromEnv,
} from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const signal = new AbortController().signal;

async function composed() {
  const fake = infisicalFake();
  const store = new ComposedSecretStore(
    new EncryptedSecretStore("key"),
    new InfisicalSecretStore(fake.options),
  );
  await store.start();
  return { fake, store };
}

describe("fork Infisical key format", () => {
  it("recognises every infisical: ref", () => {
    expect(isInfisicalRef("infisical:SECRET_abc")).toBe(true);
    expect(isInfisicalRef("infisical:v1:rakazo_x")).toBe(true);
    expect(isInfisicalRef("v2:abc")).toBe(false);
  });

  it("loads legacy unversioned and versioned refs through the composed store", async () => {
    const { fake, store } = await composed();
    fake.values.set("SECRET_rec_1", "legacy value");
    fake.values.set("SECRET_rec_1__vmabc12_0a1b2c3d", "versioned value");
    fake.values.set("SECRET_integration_provider_github", "provider value");
    await expect(store.load("infisical:SECRET_rec_1", { recordId: "rec-1", signal })).resolves.toBe(
      "legacy value",
    );
    await expect(
      store.load("infisical:SECRET_rec_1__vmabc12_0a1b2c3d", { recordId: "rec-1", signal }),
    ).resolves.toBe("versioned value");
    await expect(
      store.load("infisical:SECRET_integration_provider_github", {
        recordId: "integration-provider:github",
        signal,
      }),
    ).resolves.toBe("provider value");
  });

  it("rejects a key bound to a different record or with a malformed suffix", async () => {
    const { fake, store } = await composed();
    fake.values.set("SECRET_rec_2", "other row");
    fake.values.set("SECRET_rec_1__vbad", "bad suffix");
    await expect(
      store.load("infisical:SECRET_rec_2", { recordId: "rec-1", signal }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(
      store.load("infisical:SECRET_rec_1__vbad", { recordId: "rec-1", signal }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(
      store.load("infisical:SECRET_rec_10", { recordId: "rec-1", signal }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("writes the fork key and ref shape with a secret comment", async () => {
    const { fake, store } = await composed();
    const record = await store.put("new value", context, { recordId: "row-9" });
    expect(record.id).toBe("row-9");
    expect(record.ref).toMatch(/^infisical:SECRET_row_9__v[0-9a-z]+_[0-9a-f]{8}$/);
    expect(record.ciphertext).toBe(record.ref);
    const post = fake.fetcher.mock.calls.find(
      ([input, init]) => init?.method === "POST" && String(input).includes("/secrets/raw/"),
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      secretValue: "new value",
      secretComment: "op-1",
    });
    expect(fake.values.get(record.ref.slice("infisical:".length))).toBe("new value");
    await expect(store.load(record.ref, { recordId: "row-9", signal })).resolves.toBe("new value");
  });

  it("still reads upstream-format refs", async () => {
    const fake = infisicalFake();
    const remote = new InfisicalSecretStore(fake.options);
    const upstreamKey = `rakazo_${credentialDigest("row").slice(0, 24)}_00000000-0000-0000-0000-000000000000`;
    fake.values.set(upstreamKey, "upstream");
    await expect(remote.load(`infisical:v1:${upstreamKey}`, "row")).resolves.toBe("upstream");
    await expect(remote.load(`infisical:v1:${upstreamKey}`, "other")).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
  });

  it("drops cached values on the legacy secret-store:changed topic", async () => {
    const fake = infisicalFake();
    const handlers = new Map<string, (payload: string) => void>();
    const realtime: RealtimeFanout = {
      publish: vi.fn(async () => undefined),
      subscribe: vi.fn(async (topic: string, handler: (payload: string) => void) => {
        handlers.set(topic, handler);
        return async () => undefined;
      }),
    } as unknown as RealtimeFanout;
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("key"),
      new InfisicalSecretStore(fake.options),
      realtime,
    );
    await store.start();
    fake.values.set("SECRET_rec", "before");
    await expect(store.load("infisical:SECRET_rec", "rec")).resolves.toBe("before");
    fake.values.set("SECRET_rec", "after");
    await expect(store.load("infisical:SECRET_rec", "rec")).resolves.toBe("before");
    handlers.get("secret-store:changed")?.("SECRET_rec");
    await expect(store.load("infisical:SECRET_rec", "rec")).resolves.toBe("after");
    await store.close();
  });
});

describe("fork migration compat", () => {
  it("reports existing fork refs as verified without writing", async () => {
    const { fake, store } = await composed();
    fake.values.set("SECRET_row", "legacy");
    fake.values.set("SECRET_row2__vmabc_0a1b2c3d", "versioned");
    const rows: SecretMigrationRow[] = [
      { id: "row", recordId: "row", label: "secret", ref: "infisical:SECRET_row" },
      {
        id: "row2",
        recordId: "row2",
        label: "botSecret",
        ref: "infisical:SECRET_row2__vmabc_0a1b2c3d",
      },
    ];
    const repository: SecretMigrationRepository = {
      async *rows() {
        yield* rows;
      },
      replace: vi.fn(async () => true),
      referenced: vi.fn(async () => true),
    };
    const report = vi.fn();
    const counts = await migrateSecrets(
      repository,
      new EncryptedSecretStore("key"),
      store,
      context,
      { direction: "forward", dryRun: true, report },
    );
    expect(counts).toMatchObject({ verified: 2, failed: 0, planned: 0, migrated: 0 });
    expect(report).toHaveBeenCalledWith(rows[0], "verified");
    expect(repository.replace).not.toHaveBeenCalled();
  });
});

describe("fork env aliases", () => {
  const base = {
    SECRET_STORE: "infisical",
    INFISICAL_CLIENT_ID: "id",
    INFISICAL_CLIENT_SECRET: "secret",
    INFISICAL_PROJECT_ID: "project",
    INFISICAL_ENVIRONMENT: "prod",
  };

  it("accepts the fork names, including when compose injects empty upstream names", () => {
    const options = secretStoreOptionsFromEnv({
      ...base,
      INFISICAL_URL: "",
      INFISICAL_FOLDER: " ",
      INFISICAL_SITE_URL: "https://vault.example.test",
      INFISICAL_SECRET_PATH: "/app",
      INFISICAL_REFRESH_SECONDS: "45",
    });
    expect(options).toMatchObject({
      baseUrl: "https://vault.example.test",
      folder: "/app",
      cacheTtlMs: 45_000,
    });
  });

  it("prefers the upstream names when set", () => {
    const options = secretStoreOptionsFromEnv({
      ...base,
      INFISICAL_URL: "https://new.example.test",
      INFISICAL_FOLDER: "/new",
      INFISICAL_SITE_URL: "https://old.example.test",
      INFISICAL_SECRET_PATH: "/app",
    });
    expect(options).toMatchObject({ baseUrl: "https://new.example.test", folder: "/new" });
    expect(options?.cacheTtlMs).toBeUndefined();
  });

  it("names both variables when neither is set and rejects a bad refresh period", () => {
    expect(() => secretStoreOptionsFromEnv(base)).toThrow(
      "Missing INFISICAL_URL (or INFISICAL_SITE_URL)",
    );
    expect(() =>
      secretStoreOptionsFromEnv({
        ...base,
        INFISICAL_SITE_URL: "https://vault.example.test",
        INFISICAL_SECRET_PATH: "/app",
        INFISICAL_REFRESH_SECONDS: "soon",
      }),
    ).toThrow("INFISICAL_REFRESH_SECONDS");
  });

  it("treats unset, empty and database SECRET_STORE as the encrypted store", () => {
    expect(secretStoreOptionsFromEnv({})).toBeUndefined();
    expect(secretStoreOptionsFromEnv({ SECRET_STORE: "" })).toBeUndefined();
    expect(secretStoreOptionsFromEnv({ SECRET_STORE: "database" })).toBeUndefined();
    expect(createSecretStore("key", { SECRET_STORE: "database" }).describe().id).toBe(
      "app-encrypted",
    );
  });
});
