import type { PrismaClient } from "@rakazo/db";
import { oidcAccountSubject } from "./oidc.js";

/**
 * Fork: before the upstream OIDC sync, the fork stored the raw ID token `sub` as
 * the OIDC account id. Upstream looks accounts up by a hash of (issuer, sub), so
 * those rows would fail with "account not linked". Rewrites a row only when its
 * stored ID token (verified when it was stored) has this issuer and a `sub`
 * equal to the account id, so it is safe to run at every startup.
 */
export async function migrateOidcAccountIds(
  prisma: Pick<PrismaClient, "account">,
  issuer: string,
  log: (message: string, details: Record<string, unknown>) => void = () => undefined,
): Promise<{ migrated: number }> {
  const accounts = await prisma.account.findMany({
    where: { providerId: "oidc" },
    select: { id: true, accountId: true, idToken: true },
  });
  let migrated = 0;
  for (const account of accounts) {
    if (!account.idToken) {
      log("OIDC account has no stored ID token; account id left unchanged", {
        accountRowId: account.id,
      });
      continue;
    }
    let claims: { iss?: unknown; sub?: unknown };
    try {
      claims = JSON.parse(
        Buffer.from(account.idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
      );
    } catch {
      continue;
    }
    if (claims?.iss !== issuer || claims.sub !== account.accountId) continue;
    await prisma.account.update({
      where: { id: account.id },
      data: { accountId: oidcAccountSubject(issuer, account.accountId) },
    });
    migrated += 1;
  }
  return { migrated };
}
