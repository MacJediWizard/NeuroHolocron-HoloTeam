/**
 * Moves stored secret values into Infisical (see InfisicalSecretStore).
 *   pnpm --filter @rakazo/api secrets:infisical [--dry-run] [--prune]
 * Reads the same INFISICAL_* settings as the running app. Prints row ids and
 * labels only, never values.
 */
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import {
  InfisicalSecretStore,
  infisicalOptionsFromEnv,
  migrateSecretsToInfisical,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { createDb } from "@rakazo/db";

const args = new Set(process.argv.slice(2));
const print = (line: string) => process.stdout.write(`${line}\n`);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(databaseUrl, {
  poolMax: 2,
  applicationName: "rakazo-secret-migration",
});
const store = new InfisicalSecretStore(
  resolveEncryptionKey(process.env),
  infisicalOptionsFromEnv(process.env),
);
try {
  if (!args.has("--dry-run")) await store.ensureFolder();
  const report = await migrateSecretsToInfisical(prisma, store, {
    dryRun: args.has("--dry-run"),
    prune: args.has("--prune"),
  });
  const verb = args.has("--dry-run") ? "would move" : "moved";
  for (const row of report.migrated) print(`${verb} ${row}`);
  for (const row of report.unreadable) print(`unreadable ${row}`);
  for (const key of report.orphaned) print(`unreferenced ${key}`);
  print(
    `${verb} ${report.migrated.length}, already in Infisical ${report.alreadyReferenced}, ` +
      `unreadable ${report.unreadable.length}, unreferenced ${report.orphaned.length}, pruned ${report.pruned}`,
  );
  if (report.unreadable.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
