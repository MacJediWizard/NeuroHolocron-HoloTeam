import type { PrismaClient } from "@rakazo/db";
import {
  type InfisicalSecretStore,
  infisicalSecretKey,
  isSecretReference,
} from "./infisical-secret-store.js";
import { runSecretKind } from "./run-secret.js";

export interface SecretMigrationReport {
  migrated: string[];
  alreadyReferenced: number;
  /** Rows whose value could not be decrypted with the deployment key. */
  unreadable: string[];
  /** Infisical keys no row references (deleted rows, interrupted writes). */
  orphaned: string[];
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
 * Safe to rerun: referenced rows are skipped and writes overwrite the same key.
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
    if (row.table === "secrets") await prisma.secret.updateMany({ where, data });
    else if (row.table === "bot_secrets") await prisma.botSecret.updateMany({ where, data });
    else await prisma.integrationProviderConfig.updateMany({ where, data });
  }
  const referenced = new Set(rows.map((row) => infisicalSecretKey(row.recordId)));
  report.orphaned = store.keys().filter((key) => key.startsWith("SECRET_") && !referenced.has(key));
  if (options.prune && !options.dryRun) {
    // Re-read so keys written after the snapshot above are never removed.
    const current = new Set(
      (await storedRows(prisma)).map((row) => infisicalSecretKey(row.recordId)),
    );
    for (const key of report.orphaned) {
      if (current.has(key)) continue;
      await store.remove(key);
      report.pruned += 1;
    }
  }
  return report;
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
