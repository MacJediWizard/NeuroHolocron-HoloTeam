import { afterAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { handOverSharedRows } from "./group-spaces.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("handOverSharedRows (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `handover-owner-${suffix}`;
  const memberId = `handover-member-${suffix}`;
  const organizationId = `handover-organization-${suffix}`;
  const spaceId = `handover-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await close();
  });

  it("keeps a departing member's shared rows in the Space and leaves their personal ones", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const createdAt = new Date();
    for (const id of [ownerId, memberId]) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
    await prisma.organization.create({
      data: { id: organizationId, name: "Handover", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Shared", createdByUserId: ownerId },
    });
    for (const [userId, role] of [
      [ownerId, "owner"],
      [memberId, "member"],
    ] as const) {
      await prisma.member.create({
        data: { id: `${userId}-org`, organizationId, userId, role, createdAt },
      });
      await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId } },
        create: { id: `${userId}-space`, spaceId, organizationId, userId, role, createdAt },
        update: { role },
      });
    }
    const bot = await prisma.bot.create({
      data: { spaceId, userId: memberId, name: "Shared bot", color: "blue" },
    });
    await prisma.memoryDocument.createMany({
      data: [
        { spaceId, userId: memberId, scope: "user", path: "MEMORY.md", content: "mine" },
        {
          spaceId,
          userId: memberId,
          scope: "bot",
          botId: bot.id,
          path: "NOTES.md",
          content: "ours",
        },
      ],
    });
    const credentialSecret = await prisma.secret.create({
      data: { userId: memberId, kind: "model", ciphertext: "x" },
    });
    await prisma.userModelCredential.create({
      data: { userId: memberId, provider: "anthropic", label: "A", secretId: credentialSecret.id },
    });
    const sharedSecret = await prisma.secret.create({
      data: { userId: memberId, spaceId, kind: "webhook", ciphertext: "y" },
    });

    await handOverSharedRows(prisma, memberId);
    await prisma.user.delete({ where: { id: memberId } });

    expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
      userId: ownerId,
    });
    expect(
      await prisma.memoryDocument.findMany({
        where: { spaceId },
        select: { path: true, userId: true },
        orderBy: { path: "asc" },
      }),
    ).toEqual([
      { path: "MEMORY.md", userId: memberId },
      { path: "NOTES.md", userId: ownerId },
    ]);
    expect(await prisma.secret.findUnique({ where: { id: sharedSecret.id } })).toMatchObject({
      userId: ownerId,
    });
    expect(await prisma.secret.findUnique({ where: { id: credentialSecret.id } })).toBeNull();
  });
});
