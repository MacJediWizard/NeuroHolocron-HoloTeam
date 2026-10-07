@AGENTS.md

## ABSOLUTE RULES (never violate)

- **NEVER suggest stopping, pausing, or deferring work.** Do not say "it's late", "that's enough for today", "let's tackle this next session", "want to stop here?", "want me to continue with any of these?", "the next session should focus on", "the next session has everything needed", or any variation. Do not write handoff summaries in your response — the Stop hook handles that automatically. The user decides when to stop — you execute until told otherwise.
- **NEVER downgrade a request.** If the user asks for X, build X. Do not offer a simpler alternative because "it requires significant refactoring." Do the refactoring.
- **NEVER make scope, timing, or priority decisions.** You are an engineer, not a project manager. Build what is asked.
- **NEVER write your own handoff summary.** The Stop hook agent handles session handoffs automatically. Do not summarize what was done or what's next in your response. Just keep working.
- **NEVER declare work "done" without proving it works.** Run tests, verify the build, check the UI, test the API. "It builds" is NOT "it works." If you changed frontend and backend, trace the full data flow across the boundary. Check for regressions — verify existing features still work after your changes.
- **ALWAYS check the existing stack before choosing a database.** Default to PostgreSQL for server-side projects unless the project already uses something else.
- **ALWAYS read the existing codebase before making technology decisions.** Check docker-compose, existing services, and any architecture docs before adding new dependencies.

## Fork

This repo is a fork of upstream Rakazo (`upstream` remote); `origin` is the fork. The product name is **Legiara**; it and the app ids, domain, operator, and source repo (`SOURCE_REPO`, which self-update, published images, the installer, and the desktop update feed all follow) are set once in `packages/contracts/src/brand.js`. Internal ids (`@rakazo/*`, `RAKAZO_*`, storage keys, DB names) stay as upstream so merges stay clean. After an upstream merge run `pnpm brand:apply`; `pnpm brand:check` fails if upstream brand text came back. Lines containing `brand:keep` (upstream credit) are never rewritten. Icons come from `packages/ui-tokens/assets/brand-icon.png` via `pnpm brand:icons`; re-run it after a merge that touches icon files. Code that Node or Electron loads without a bundler (desktop main, vite.config imports) must import `@rakazo/contracts/brand`, not `@rakazo/contracts`.

Fork-only features (OIDC sign-in, the Infisical secret store behind `SECRET_STORE=infisical`, fork CI switches), the upstream-sync procedure, and fork release notes are in `docs/fork.md`; keep them updated there, not in `CHANGELOG.md` or `AGENTS.md`, which upstream rewrites. Secret storage goes through the secret-store interface in `packages/adapters` (`infisical-secret-store.ts`); never read or write in-app secrets around it.

## Architecture

pnpm + Turborepo monorepo; one product across web, Electron desktop, and Expo mobile.

- `apps/api` — Hono + oRPC backend (auth, orchestration, provider translation)
- `apps/worker` — Graphile Worker background jobs
- `apps/web` — React 19 + Vite web UI (also hosted inside Electron); dev on http://127.0.0.1:5173
- `apps/desktop` — Electron shell (local Docker stack or existing instance)
- `apps/mobile` — Expo Router app with a native notifications module
- `apps/www` — marketing site
- `packages/*` — core domain, contracts, db (Prisma), auth (Better Auth), adapters (LLM/sandbox/integration providers), memory, logging, chat-ui, ui-web (shadcn on Base UI), ui-tokens, testkit
- `infra/` — Docker Compose stacks, sandbox computer image + supervisor, updater, systemd units

## Tech Stack

TypeScript, React 19, Vite, Tailwind, Electron, Expo, Hono, oRPC, PostgreSQL + Prisma, Better Auth, Graphile Worker, Pi (model access), Docker/E2B/Daytona/Box sandboxes, Composio/Pipedream/MCP/OpenAPI integrations. Biome for lint/format, Vitest for tests, TypeScript 7.

## Development

Node 22.22.2+/24/26+ (not 23/25), pnpm 9.15, Docker. Full setup (env secrets, Postgres via Compose, `db:generate`, `db:migrate`, `sandbox:build`) is in README "Local development".

Checks: `pnpm lint`, `pnpm check` (typecheck), `pnpm test`. Do not run the desktop Playwright e2e locally (see AGENTS.md).


