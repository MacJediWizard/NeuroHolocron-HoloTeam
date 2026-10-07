-- Space rows are shared by every member, so names that were unique per member
-- become unique per Space. Rows that only differed by member are renamed (or,
-- for identical approval rules, removed) before the new indexes are built.

-- Bot sections: suffix later duplicates.
WITH ranked AS (
  SELECT "id", "name", ROW_NUMBER() OVER (PARTITION BY "spaceId", "name" ORDER BY "createdAt", "id") AS n
  FROM "bot_sections"
)
UPDATE "bot_sections" AS s SET "name" = s."name" || ' (' || ranked.n || ')'
FROM ranked WHERE ranked."id" = s."id" AND ranked.n > 1;
DROP INDEX IF EXISTS "bot_sections_spaceId_userId_name_key";
DROP INDEX IF EXISTS "bot_sections_spaceId_userId_position_createdAt_idx";
CREATE UNIQUE INDEX "bot_sections_spaceId_name_key" ON "bot_sections"("spaceId", "name");
CREATE INDEX "bot_sections_spaceId_position_createdAt_idx" ON "bot_sections"("spaceId", "position", "createdAt");

-- MCP servers: suffix later duplicate slugs.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "spaceId", "slug" ORDER BY "createdAt", "id") AS n
  FROM "mcp_servers"
)
UPDATE "mcp_servers" AS m SET "slug" = m."slug" || '-' || ranked.n
FROM ranked WHERE ranked."id" = m."id" AND ranked.n > 1;
DROP INDEX IF EXISTS "mcp_servers_spaceId_userId_slug_key";
CREATE UNIQUE INDEX "mcp_servers_spaceId_slug_key" ON "mcp_servers"("spaceId", "slug");

-- Bot secrets: suffix later duplicate names.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "spaceId", "botId", "name" ORDER BY "createdAt", "id") AS n
  FROM "bot_secrets"
)
UPDATE "bot_secrets" AS b SET "name" = b."name" || '_' || ranked.n
FROM ranked WHERE ranked."id" = b."id" AND ranked.n > 1;
DROP INDEX IF EXISTS "bot_secrets_userId_spaceId_botId_name_key";
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

-- Agent skills: case-insensitive name per Space; suffix later duplicates.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "spaceId", lower("name") ORDER BY "createdAt", "id") AS n
  FROM "agent_skills"
)
UPDATE "agent_skills" AS a SET "name" = left(a."name", 74) || '-' || ranked.n
FROM ranked WHERE ranked."id" = a."id" AND ranked.n > 1;
DROP INDEX IF EXISTS "agent_skills_spaceId_userId_name_lower_key";
CREATE UNIQUE INDEX "agent_skills_spaceId_name_lower_key" ON "agent_skills"("spaceId", (lower("name")));

-- Message authors. Existing user messages were written by the thread's member.
ALTER TABLE "messages" ADD COLUMN "authorUserId" TEXT;
UPDATE "messages" AS m SET "authorUserId" = t."userId"
FROM "threads" AS t WHERE t."id" = m."threadId" AND m."role" = 'user';
ALTER TABLE "messages" ADD CONSTRAINT "messages_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
