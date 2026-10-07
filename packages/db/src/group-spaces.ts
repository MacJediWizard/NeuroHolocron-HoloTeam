import { randomBytes } from "node:crypto";
import type { PrismaClient } from "./client.js";

/** An identity provider group whose members share one Space. */
export interface GroupSpace {
  group: string;
  spaceId: string;
}

type GroupSpaceClient = Pick<
  PrismaClient,
  "$transaction" | "space" | "member" | "spaceMember" | "memoryDocument" | "notificationPreference"
>;

function newId(): string {
  return randomBytes(16).toString("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function ignoreDuplicate(write: Promise<unknown>): Promise<void> {
  await write.catch((error: unknown) => {
    if (!isUniqueViolation(error)) throw error;
  });
}

/**
 * Makes the user's membership of every group-mapped Space match their identity
 * provider groups: a member of the group joins the Space, anyone else leaves it.
 * Space owners are never removed, so a mapping cannot lock the owner out.
 * Returns the mapped Space ids that do not exist, so the caller can report them.
 */
export async function syncGroupSpaces(
  prisma: GroupSpaceClient,
  userId: string,
  groups: readonly string[],
  mapping: readonly GroupSpace[],
): Promise<{ missingSpaceIds: string[] }> {
  const wanted = new Map<string, boolean>();
  for (const { group, spaceId } of mapping) {
    wanted.set(spaceId, (wanted.get(spaceId) ?? false) || groups.includes(group));
  }
  const spaces = await prisma.space.findMany({
    where: { id: { in: [...wanted.keys()] }, deletingAt: null },
    select: { id: true, organizationId: true },
  });
  const missingSpaceIds = [...wanted.keys()].filter((id) => !spaces.some((s) => s.id === id));
  const wantedIds = new Set([...wanted].filter(([, keep]) => keep).map(([id]) => id));
  for (const space of spaces) {
    if (wantedIds.has(space.id)) await joinSpace(prisma, userId, space, wantedIds);
    else await leaveSpace(prisma, userId, space);
  }
  return { missingSpaceIds };
}

async function joinSpace(
  prisma: GroupSpaceClient,
  userId: string,
  space: { id: string; organizationId: string },
  wantedIds: ReadonlySet<string>,
): Promise<void> {
  const createdAt = new Date();
  const memberId = newId();
  const joined = await prisma.member
    .create({
      data: {
        id: memberId,
        organizationId: space.organizationId,
        userId,
        role: "member",
        createdAt,
      },
    })
    .then(
      () => true,
      (error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
        return false;
      },
    );
  if (joined) {
    // The member insert trigger also adds the organization's default Space,
    // which the group may not grant.
    await prisma.spaceMember.deleteMany({
      where: { id: `default-space-member:${memberId}`, spaceId: { notIn: [...wantedIds] } },
    });
  }
  await ignoreDuplicate(
    prisma.spaceMember.create({
      data: {
        id: newId(),
        spaceId: space.id,
        organizationId: space.organizationId,
        userId,
        role: "member",
        createdAt,
      },
    }),
  );
  const hasMemory = await prisma.memoryDocument.findFirst({
    where: { spaceId: space.id, userId, scope: "user", path: "MEMORY.md" },
    select: { id: true },
  });
  if (!hasMemory) {
    await ignoreDuplicate(
      prisma.memoryDocument.create({
        data: {
          spaceId: space.id,
          userId,
          scope: "user",
          path: "MEMORY.md",
          content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        },
      }),
    );
  }
  await ignoreDuplicate(
    prisma.notificationPreference.create({ data: { spaceId: space.id, userId } }),
  );
}

async function leaveSpace(
  prisma: GroupSpaceClient,
  userId: string,
  space: { id: string; organizationId: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.spaceMember.deleteMany({
      where: { spaceId: space.id, userId, role: { not: "owner" } },
    });
    // Without a Space left in the organization, the organization membership goes too.
    const remaining = await tx.spaceMember.count({
      where: { organizationId: space.organizationId, userId },
    });
    if (remaining === 0) {
      await tx.member.deleteMany({
        where: { organizationId: space.organizationId, userId, role: { not: "owner" } },
      });
    }
  });
}

/**
 * Parses `group:spaceId` pairs separated by commas. A group may map to several
 * Spaces and several groups to one Space.
 */
export function parseGroupSpaces(value: string | undefined): GroupSpace[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const separator = entry.lastIndexOf(":");
    const group = entry.slice(0, separator).trim();
    const spaceId = entry.slice(separator + 1).trim();
    if (separator < 0 || !group || !spaceId) {
      throw new Error(`OIDC_GROUP_SPACES entry "${entry.trim()}" must be group:spaceId`);
    }
    return { group, spaceId };
  });
}
