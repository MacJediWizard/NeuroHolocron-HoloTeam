import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { isSpaceOwner, type PrismaClient } from "@rakazo/db";

/** Members share a Space; settings tied to the owner's account stay with the owner. */
export async function requireSpaceOwner(
  prisma: Pick<PrismaClient, "spaceMember">,
  actor: Actor,
): Promise<void> {
  if (!(await isSpaceOwner(prisma, actor))) {
    throw new ORPCError("FORBIDDEN", { message: "Only the Space owner can do this" });
  }
}
