import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const membership = await prisma.spaceMember.findFirst({
    where: {
      userId,
      ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
    },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    include: { member: { include: { user: true } } },
  });
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  return {
    userId: membership.userId,
    spaceId: membership.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: settings?.ownerUserId === membership.userId,
  };
}

/** Space rows are shared by every member, so a record only has to sit in the actor's Space. */
export function scoped<T extends { spaceId: string }>(actor: Actor, record: T | null): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  return record;
}

type OwnerLookup = Pick<PrismaClient, "spaceMember">;

/** Roles are comma-separated, so "owner,admin" is an owner too. */
export function hasOwnerRole(role: string | undefined): boolean {
  return role?.split(",").some((part) => part.trim() === "owner") ?? false;
}

export async function isSpaceOwner(
  prisma: OwnerLookup,
  actor: Pick<Actor, "spaceId" | "userId">,
): Promise<boolean> {
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  return hasOwnerRole(membership?.role);
}

/**
 * The member whose account backs a Space: model and voice credentials, connected
 * apps and computer quota all resolve through this user, so members of a shared
 * Space run on the owner's setup. The oldest owner wins if several exist.
 */
export async function spaceOwnerUserId(prisma: OwnerLookup, spaceId: string): Promise<string> {
  const owners = await prisma.spaceMember.findMany({
    where: { spaceId, role: { contains: "owner" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { userId: true, role: true },
  });
  const owner = owners.find((row) => hasOwnerRole(row.role));
  if (!owner) throw new IsolationError("Space has no owner");
  return owner.userId;
}

/** The actor's scope with the userId swapped for the Space owner's. */
export async function ownerScope<T extends { spaceId: string; userId: string }>(
  prisma: OwnerLookup,
  scope: T,
): Promise<T> {
  const userId = await spaceOwnerUserId(prisma, scope.spaceId);
  return userId === scope.userId ? scope : { ...scope, userId };
}
