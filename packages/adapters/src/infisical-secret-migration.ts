import type { PrismaClient } from "@rakazo/db";
import type { InfisicalSecretStore } from "./infisical-secret-store.js";
import { INFISICAL_REFERENCE_PREFIX, isSecretReference } from "./infisical-secret-store.js";
import { runSecretKind } from "./run-secret.js";

export interface SecretMigrationReport {
  migrated: string[];
  alreadyReferenced: number;
  /** Rows whose value could not be decrypted with the deployment key. */
  unreadable: string[];
  /** Infisical keys no row references (deleted rows, replaced or interrupted saves). */
  orphaned: string[];
  /** Orphaned keys removed; recent ones are kept in case their save is still committing. */
  pruned: number;
}

interface StoredRow {
  table: "secrets" | "bot_secrets" | "integration_provider_configs";
  id: string;
  recordId: string;
  ciphertext: string;
  spaceId: string | null;
  userId: string;
  label: string;
}

const RUN_SECRET_PREFIX = runSecretKind("");

/**
 * Moves every long-lived secret value into Infisical and leaves a reference in
 * its row. One-time codes and OAuth handshakes stay local; they expire in minutes.
 * Safe to rerun, and safe while the app runs: each copy goes to a new key, and a
 * row edited meanwhile keeps its new value.
 */
export async function migrateSecretsToInfisical(
  prisma: PrismaClient,
  store: InfisicalSecretStore,
  options: { dryRun?: boolean; prune?: boolean } = {},
): Promise<SecretMigrationReport> {
  await store.refresh();
  const rows = await storedRows(prisma);
  const report: SecretMigrationReport = {
    migrated: [],
    alreadyReferenced: 0,
    unreadable: [],
    orphaned: [],
    pruned: 0,
  };
  for (const row of rows) {
    if (isSecretReference(row.ciphertext)) {
      report.alreadyReferenced += 1;
      continue;
    }
    let plaintext: string;
    try {
      plaintext = store.load(row.ciphertext, row.recordId);
    } catch {
      report.unreadable.push(`${row.table}:${row.id}`);
      continue;
    }
    report.migrated.push(`${row.table}:${row.id} (${row.label})`);
    if (options.dryRun) continue;
    const stored = await store.put(
      plaintext,
      {
        operationId: "secret-migration",
        traceId: "secret-migration",
        spaceId: row.spaceId ?? "",
        userId: row.userId,
        signal: new AbortController().signal,
      },
      row.recordId,
      { label: row.label },
    );
    // Only replace the value that was copied; a concurrent edit wins and is
    // picked up on the next run.
    const where = { id: row.id, ciphertext: row.ciphertext };
    const data = { ciphertext: stored.ciphertext };
    const { count } =
      row.table === "secrets"
        ? await prisma.secret.updateMany({ where, data })
        : row.table === "bot_secrets"
          ? await prisma.botSecret.updateMany({ where, data })
          : await prisma.integrationProviderConfig.updateMany({ where, data });
    if (count === 0) await store.remove(stored.ciphertext.slice(INFISICAL_REFERENCE_PREFIX.length));
  }
  const referenced = new Set(await infisicalReferencedKeys(prisma));
  report.orphaned = store.keys().filter((key) => key.startsWith("SECRET_") && !referenced.has(key));
  if (options.prune && !options.dryRun) report.pruned = (await store.sweep(referenced)).length;
  return report;
}

/** Infisical keys that rows currently reference. */
export async function infisicalReferencedKeys(prisma: PrismaClient): Promise<string[]> {
  const where = { ciphertext: { startsWith: INFISICAL_REFERENCE_PREFIX } };
  const select = { ciphertext: true } as const;
  const tables = await Promise.all([
    prisma.secret.findMany({ where, select }),
    prisma.botSecret.findMany({ where, select }),
    prisma.integrationProviderConfig.findMany({ where, select }),
  ]);
  return tables
    .flat()
    .filter((row) => isSecretReference(row.ciphertext))
    .map((row) => row.ciphertext.slice(INFISICAL_REFERENCE_PREFIX.length));
}

async function storedRows(prisma: PrismaClient): Promise<StoredRow[]> {
  const [secrets, botSecrets, providers] = await Promise.all([
    prisma.secret.findMany({
      where: { NOT: { kind: { startsWith: RUN_SECRET_PREFIX } } },
      select: {
        id: true,
        kind: true,
        ciphertext: true,
        spaceId: true,
        userId: true,
        mcpServers: { select: { name: true } },
        agentSecret: { select: { name: true } },
      },
    }),
    prisma.botSecret.findMany({
      select: {
        id: true,
        name: true,
        ciphertext: true,
        spaceId: true,
        userId: true,
        bot: { select: { name: true } },
      },
    }),
    prisma.integrationProviderConfig.findMany({ select: { id: true, ciphertext: true } }),
  ]);
  return [
    ...secrets.map((row) => ({
      table: "secrets" as const,
      id: row.id,
      recordId: row.id,
      ciphertext: row.ciphertext,
      spaceId: row.spaceId,
      userId: row.userId,
      label: row.agentSecret
        ? `agent environment ${row.agentSecret.name}`
        : row.mcpServers[0]
          ? `MCP server ${row.mcpServers[0].name}`
          : row.kind,
    })),
    ...botSecrets.map((row) => ({
      table: "bot_secrets" as const,
      id: row.id,
      recordId: row.id,
      ciphertext: row.ciphertext,
      spaceId: row.spaceId,
      userId: row.userId,
      label: `${row.bot.name} credential ${row.name}`,
    })),
    ...providers.map((row) => ({
      table: "integration_provider_configs" as const,
      id: row.id,
      recordId: `integration-provider:${row.id}`,
      ciphertext: row.ciphertext,
      spaceId: null,
      userId: "",
      label: `integration provider ${row.id}`,
    })),
  ];
}
