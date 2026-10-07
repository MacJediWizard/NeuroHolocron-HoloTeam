import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  handOverSharedRows,
  parseGroupSpaces,
  syncGroupSpaces,
  transferOwnedSpaces,
} from "./group-spaces.js";

function makePrisma(options: {
  spaces: Array<{ id: string; organizationId: string }>;
  remaining?: number;
  spaceRole?: string;
  orgRole?: string;
}) {
  const prisma = {
    space: {
      findMany: vi.fn(async (input: { where: { id: { in: string[] } } }) =>
        options.spaces.filter((space) => input.where.id.in.includes(space.id)),
      ),
    },
    member: {
      create: vi.fn(async (_input: { data: Record<string, unknown> }) => ({})),
      deleteMany: vi.fn(async (_input: { where: Record<string, unknown> }) => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ id: "org-member", role: options.orgRole ?? "member" })),
    },
    spaceMember: {
      findUnique: vi.fn(async () => ({ role: options.spaceRole ?? "member" })),
      create: vi.fn(async (_input: { data: Record<string, unknown> }) => ({})),
      deleteMany: vi.fn(async (_input: { where: Record<string, unknown> }) => ({ count: 1 })),
      count: vi.fn(async () => options.remaining ?? 0),
    },
    memoryDocument: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (_input: { data: Record<string, unknown> }) => ({})),
    },
    notificationPreference: {
      create: vi.fn(async (_input: { data: Record<string, unknown> }) => ({})),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
  };
  return prisma;
}

const duplicate = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

describe("parseGroupSpaces", () => {
  it("reads group:spaceId pairs", () => {
    expect(parseGroupSpaces(" orca:space-1, ops team:space-2 ")).toEqual([
      { group: "orca", spaceId: "space-1" },
      { group: "ops team", spaceId: "space-2" },
    ]);
  });

  it("is empty when unset", () => {
    expect(parseGroupSpaces(undefined)).toEqual([]);
    expect(parseGroupSpaces("  ")).toEqual([]);
  });

  it("refuses an entry without a group or Space", () => {
    expect(() => parseGroupSpaces("orca")).toThrow("must be group:spaceId");
    expect(() => parseGroupSpaces("orca:")).toThrow("must be group:spaceId");
    expect(() => parseGroupSpaces(":space-1")).toThrow("must be group:spaceId");
  });
});

describe("syncGroupSpaces", () => {
  const mapping = [{ group: "orca", spaceId: "space-1" }];

  it("adds a group member to the Space as a member", async () => {
    const prisma = makePrisma({ spaces: [{ id: "space-1", organizationId: "org-1" }] });
    await syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", ["orca"], mapping);

    expect(prisma.member.create.mock.calls[0]?.[0].data).toMatchObject({
      organizationId: "org-1",
      userId: "user-2",
      role: "member",
    });
    expect(prisma.spaceMember.create.mock.calls[0]?.[0].data).toMatchObject({
      spaceId: "space-1",
      organizationId: "org-1",
      userId: "user-2",
      role: "member",
    });
    expect(prisma.memoryDocument.create).toHaveBeenCalledOnce();
    expect(prisma.notificationPreference.create).toHaveBeenCalledOnce();
  });

  it("drops the default Space the member trigger added unless the group grants it", async () => {
    const prisma = makePrisma({ spaces: [{ id: "space-1", organizationId: "org-1" }] });
    await syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", ["orca"], mapping);

    const memberId = prisma.member.create.mock.calls[0]?.[0].data.id;
    expect(prisma.spaceMember.deleteMany).toHaveBeenCalledWith({
      where: { id: `default-space-member:${memberId}`, spaceId: { notIn: ["space-1"] } },
    });
  });

  it("keeps an existing membership on a repeat sign-in", async () => {
    const prisma = makePrisma({ spaces: [{ id: "space-1", organizationId: "org-1" }] });
    prisma.member.create.mockRejectedValue(duplicate);
    prisma.spaceMember.create.mockRejectedValue(duplicate);
    prisma.notificationPreference.create.mockRejectedValue(duplicate);

    await expect(
      syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", ["orca"], mapping),
    ).resolves.toEqual({ missingSpaceIds: [] });
    expect(prisma.spaceMember.deleteMany).not.toHaveBeenCalled();
  });

  it("removes someone who left the group, but never an owner", async () => {
    const prisma = makePrisma({ spaces: [{ id: "space-1", organizationId: "org-1" }] });
    await syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", ["other"], mapping);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.spaceMember.deleteMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: "user-2" },
    });
    expect(prisma.member.deleteMany).toHaveBeenCalledWith({ where: { id: "org-member" } });
  });

  it("keeps an owner whose role lists more than owner", async () => {
    const prisma = makePrisma({
      spaces: [{ id: "space-1", organizationId: "org-1" }],
      spaceRole: "admin,owner",
    });
    await syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", [], mapping);

    expect(prisma.spaceMember.deleteMany).not.toHaveBeenCalled();
    expect(prisma.member.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps an organization owner after their last Space membership goes", async () => {
    const prisma = makePrisma({
      spaces: [{ id: "space-1", organizationId: "org-1" }],
      orgRole: "owner,admin",
    });
    await syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", [], mapping);

    expect(prisma.spaceMember.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.member.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the organization membership while another Space in it remains", async () => {
    const prisma = makePrisma({
      spaces: [{ id: "space-1", organizationId: "org-1" }],
      remaining: 1,
    });
    await syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", [], mapping);

    expect(prisma.spaceMember.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.member.deleteMany).not.toHaveBeenCalled();
  });

  it("joins a Space any of its groups grants", async () => {
    const prisma = makePrisma({ spaces: [{ id: "space-1", organizationId: "org-1" }] });
    await syncGroupSpaces(
      prisma as unknown as PrismaClient,
      "user-2",
      ["ops"],
      [
        { group: "orca", spaceId: "space-1" },
        { group: "ops", spaceId: "space-1" },
      ],
    );

    expect(prisma.spaceMember.create).toHaveBeenCalledOnce();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("reports mapped Spaces that do not exist", async () => {
    const prisma = makePrisma({ spaces: [] });
    await expect(
      syncGroupSpaces(prisma as unknown as PrismaClient, "user-2", ["orca"], mapping),
    ).resolves.toEqual({ missingSpaceIds: ["space-1"] });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
});

describe("handOverSharedRows", () => {
  const models = [
    "bot",
    "botSection",
    "chatGroup",
    "thread",
    "routine",
    "artifact",
    "mcpServer",
    "botSecret",
    "secret",
    "connection",
    "agentSkill",
    "taughtSkill",
    "scratchpadItem",
    "capabilityInstall",
    "memoryDocument",
    "actionApprovalRule",
    "agentSecret",
    "computer",
    "browserProfile",
    "cloudAgent",
  ] as const;

  function handOverPrisma(memberships: Array<{ spaceId: string; userId: string; role: string }>) {
    const tx = Object.fromEntries(
      models.map((model) => [model, { updateMany: vi.fn(async () => ({ count: 1 })) }]),
    ) as Record<(typeof models)[number], { updateMany: ReturnType<typeof vi.fn> }>;
    const prisma = {
      spaceMember: {
        findMany: vi.fn(async (input: { where: { userId?: string; spaceId?: string } }) =>
          memberships.filter(
            (row) =>
              (!input.where.userId || row.userId === input.where.userId) &&
              (!input.where.spaceId ||
                (row.spaceId === input.where.spaceId && row.role.includes("owner"))),
          ),
        ),
        findUnique: vi.fn(
          async (input: { where: { spaceId_userId: { spaceId: string; userId: string } } }) =>
            memberships.find(
              (row) =>
                row.spaceId === input.where.spaceId_userId.spaceId &&
                row.userId === input.where.spaceId_userId.userId,
            ) ?? null,
        ),
      },
      $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) => run(tx)),
    };
    return { prisma: prisma as unknown as PrismaClient, tx };
  }

  it("gives the owner the leaving member's shared rows in Spaces they do not own", async () => {
    const { prisma, tx } = handOverPrisma([
      { spaceId: "shared", userId: "member", role: "member" },
      { spaceId: "shared", userId: "owner", role: "owner" },
    ]);

    await handOverSharedRows(prisma, "member");

    const where = { spaceId: "shared", userId: "member" };
    const data = { userId: "owner" };
    for (const model of ["bot", "thread", "secret", "computer", "cloudAgent"] as const) {
      expect(tx[model].updateMany).toHaveBeenCalledWith({ where, data });
    }
    expect(tx.memoryDocument.updateMany).toHaveBeenCalledWith({
      where: { ...where, scope: { not: "user" } },
      data,
    });
    expect(tx.actionApprovalRule.updateMany).toHaveBeenCalledWith({
      where: { spaceId: "shared", createdByUserId: "member" },
      data: { createdByUserId: "owner" },
    });
    expect(tx.agentSecret.updateMany).toHaveBeenCalledWith({
      where: { spaceId: "shared", createdByUserId: "member" },
      data: { createdByUserId: "owner" },
    });
  });

  it("leaves Spaces the user owns alone, so their rows are deleted with the account", async () => {
    const { prisma, tx } = handOverPrisma([
      { spaceId: "own", userId: "owner", role: "owner" },
      { spaceId: "own", userId: "member", role: "member" },
    ]);

    await handOverSharedRows(prisma, "owner");

    for (const model of models) expect(tx[model].updateMany).not.toHaveBeenCalled();
  });
});

describe("transferOwnedSpaces", () => {
  const makeOwnerPrisma = (successor: { id: string } | null) => {
    const prisma = {
      spaceMember: {
        findMany: vi.fn(async () => [
          { id: "m-own", spaceId: "shared", role: "admin,owner" },
          { id: "m-joined", spaceId: "joined", role: "member" },
        ]),
        findFirst: vi.fn(async () => successor),
        update: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    };
    return prisma;
  };

  it("makes the longest-standing other member the owner of each owned Space", async () => {
    const prisma = makeOwnerPrisma({ id: "m-next" });
    await transferOwnedSpaces(prisma as unknown as PrismaClient, "owner");

    expect(prisma.spaceMember.findFirst).toHaveBeenCalledOnce();
    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith({
      where: { spaceId: "shared", userId: { not: "owner" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(prisma.spaceMember.update.mock.calls).toEqual([
      [{ where: { id: "m-next" }, data: { role: "owner" } }],
      [{ where: { id: "m-own" }, data: { role: "member" } }],
    ]);
  });

  it("leaves a Space with no other member alone", async () => {
    const prisma = makeOwnerPrisma(null);
    await transferOwnedSpaces(prisma as unknown as PrismaClient, "owner");

    expect(prisma.spaceMember.update).not.toHaveBeenCalled();
  });
});
