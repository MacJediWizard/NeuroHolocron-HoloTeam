-- Space rows are shared by every member, so names that were unique per member
-- become unique per Space. Rows that only differed by member are renamed (or,
-- for identical approval rules, removed) before the new indexes are built.

-- Each loop renames later duplicates (oldest first keeps its name) to the first
-- suffix still unused in that Space, so a generated name never collides with an
-- existing one. Old per-member indexes go first so they cannot block a rename.

-- Bot sections: "name (2)", "name (3)", ...
DROP INDEX IF EXISTS "bot_sections_spaceId_userId_name_key";
DROP INDEX IF EXISTS "bot_sections_spaceId_userId_position_createdAt_idx";
DO $$
DECLARE r RECORD; k INT; candidate TEXT;
BEGIN
  FOR r IN
    SELECT "id", "spaceId", "name" FROM (
      SELECT "id", "spaceId", "name",
        ROW_NUMBER() OVER (PARTITION BY "spaceId", "name" ORDER BY "createdAt", "id") AS n
      FROM "bot_sections"
    ) ranked WHERE n > 1 ORDER BY "spaceId", "name", n
  LOOP
    k := 2;
    LOOP
      candidate := r."name" || ' (' || k || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "bot_sections" WHERE "spaceId" = r."spaceId" AND "name" = candidate
      );
      k := k + 1;
    END LOOP;
    UPDATE "bot_sections" SET "name" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;
CREATE UNIQUE INDEX "bot_sections_spaceId_name_key" ON "bot_sections"("spaceId", "name");
CREATE INDEX "bot_sections_spaceId_position_createdAt_idx" ON "bot_sections"("spaceId", "position", "createdAt");

-- MCP servers: "slug-2", "slug-3", ...
DROP INDEX IF EXISTS "mcp_servers_spaceId_userId_slug_key";
DO $$
DECLARE r RECORD; k INT; candidate TEXT;
BEGIN
  FOR r IN
    SELECT "id", "spaceId", "slug" FROM (
      SELECT "id", "spaceId", "slug",
        ROW_NUMBER() OVER (PARTITION BY "spaceId", "slug" ORDER BY "createdAt", "id") AS n
      FROM "mcp_servers"
    ) ranked WHERE n > 1 ORDER BY "spaceId", "slug", n
  LOOP
    k := 2;
    LOOP
      candidate := r."slug" || '-' || k;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "mcp_servers" WHERE "spaceId" = r."spaceId" AND "slug" = candidate
      );
      k := k + 1;
    END LOOP;
    UPDATE "mcp_servers" SET "slug" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;
CREATE UNIQUE INDEX "mcp_servers_spaceId_slug_key" ON "mcp_servers"("spaceId", "slug");

-- Bot secrets: "NAME_2", "NAME_3", ... per bot.
DROP INDEX IF EXISTS "bot_secrets_userId_spaceId_botId_name_key";
DO $$
DECLARE r RECORD; k INT; candidate TEXT;
BEGIN
  FOR r IN
    SELECT "id", "spaceId", "botId", "name" FROM (
      SELECT "id", "spaceId", "botId", "name",
        ROW_NUMBER() OVER (PARTITION BY "spaceId", "botId", "name" ORDER BY "createdAt", "id") AS n
      FROM "bot_secrets"
    ) ranked WHERE n > 1 ORDER BY "spaceId", "botId", "name", n
  LOOP
    k := 2;
    LOOP
      candidate := r."name" || '_' || k;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "bot_secrets"
        WHERE "spaceId" = r."spaceId" AND "botId" = r."botId" AND "name" = candidate
      );
      k := k + 1;
    END LOOP;
    UPDATE "bot_secrets" SET "name" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;
CREATE UNIQUE INDEX "bot_secrets_spaceId_botId_name_key" ON "bot_secrets"("spaceId", "botId", "name");

-- Approval rules: identical rules from different members collapse to the oldest.
DELETE FROM "action_approval_rules" AS r
USING "action_approval_rules" AS keep
WHERE r."spaceId" = keep."spaceId" AND r."effect" = keep."effect"
  AND r."matchKind" = keep."matchKind" AND r."matchValue" = keep."matchValue"
  AND (keep."createdAt", keep."id") < (r."createdAt", r."id");
DROP INDEX IF EXISTS "action_approval_rules_spaceId_createdByUserId_effect_matchK_key";
CREATE UNIQUE INDEX "action_approval_rules_spaceId_effect_matchKind_matchValue_key"
  ON "action_approval_rules"("spaceId", "effect", "matchKind", "matchValue");

-- Agent skills: case-insensitive name per Space, at most 80 characters: "name-2", ...
DROP INDEX IF EXISTS "agent_skills_spaceId_userId_name_lower_key";
DO $$
DECLARE r RECORD; k INT; candidate TEXT;
BEGIN
  FOR r IN
    SELECT "id", "spaceId", "name" FROM (
      SELECT "id", "spaceId", "name",
        ROW_NUMBER() OVER (PARTITION BY "spaceId", lower("name") ORDER BY "createdAt", "id") AS n
      FROM "agent_skills"
    ) ranked WHERE n > 1 ORDER BY "spaceId", lower("name"), n
  LOOP
    k := 2;
    LOOP
      candidate := left(r."name", 80 - length('-' || k)) || '-' || k;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "agent_skills" WHERE "spaceId" = r."spaceId" AND lower("name") = lower(candidate)
      );
      k := k + 1;
    END LOOP;
    UPDATE "agent_skills" SET "name" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;
CREATE UNIQUE INDEX "agent_skills_spaceId_name_lower_key" ON "agent_skills"("spaceId", (lower("name")));

-- Message authors. Existing user messages were written by the thread's member.
ALTER TABLE "messages" ADD COLUMN "authorUserId" TEXT;
UPDATE "messages" AS m SET "authorUserId" = t."userId"
FROM "threads" AS t WHERE t."id" = m."threadId" AND m."role" = 'user';
ALTER TABLE "messages" ADD CONSTRAINT "messages_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
