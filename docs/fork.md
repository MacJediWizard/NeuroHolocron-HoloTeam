# Legiara fork

Legiara is a fork of [Rakazo](https://github.com/elie222/rakazo). This page lists what the fork adds
and how it stays mergeable with upstream. Upstream changes are in [CHANGELOG.md](../CHANGELOG.md).

## Fork features

| Feature | Configure with | Docs |
| --- | --- | --- |
| Single sign-on through any OpenID Connect provider, optionally SSO-only | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME`, `AUTH_PASSWORD_ENABLED` | [Self-hosting: Single sign-on](./self-host.md#single-sign-on-oidc) |
| Shared Spaces: provider groups add members to a Space that they share with its owner | `OIDC_GROUP_SPACES`, `OIDC_GROUPS_CLAIM` | [Self-hosting: Shared Spaces](./self-host.md#shared-spaces-from-provider-groups) |
| In-app secrets (model keys, integration credentials, bot secrets) kept in Infisical instead of Postgres | `SECRET_STORE=infisical` and `INFISICAL_*` | [Self-host secrets: Infisical](./self-host-secrets.md#keeping-in-app-secrets-in-infisical-optional) |
| Images, installer, and desktop updates published from this repository | `SOURCE_REPO` in `packages/contracts/src/brand.js` | [Published images and tags](./self-host.md#published-images-and-tags) |
| CI that runs without upstream's paid services | Repository variables | [Fork CI](./fork-ci.md) |

Every fork feature is off unless configured, so a deployment without these variables behaves like
upstream.

## Infisical secret store

The API reads and writes in-app secrets through one secret-store interface. The default store
encrypts each value with `ENCRYPTION_KEY` and keeps it in Postgres. With `SECRET_STORE=infisical`,
values live in an Infisical folder used only by the app, and the API keeps an in-memory mirror that
refreshes every `INFISICAL_REFRESH_SECONDS` and after every write. Each save writes a new key, so a
failed save never changes the value in use, and the API deletes keys no row references once they
are an hour old. A value edited in Infisical is picked up on the next refresh, and MCP sessions
reconnect with it.

```env
SECRET_STORE=infisical
INFISICAL_SITE_URL=https://infisical.example.com
INFISICAL_CLIENT_ID=...
INFISICAL_CLIENT_SECRET=...
INFISICAL_PROJECT_ID=...
INFISICAL_ENVIRONMENT=prod
INFISICAL_SECRET_PATH=/app
# INFISICAL_REFRESH_SECONDS=30
```

Give the machine identity access to that folder only; the app owns every key in it. Deploy with the
setting on, then move rows written before the switch (keep a database backup from before the
first run):

```sh
pnpm --filter @rakazo/api secrets:infisical --dry-run   # lists row ids, no values
pnpm --filter @rakazo/api secrets:infisical             # copies, then swaps each row to a reference
pnpm --filter @rakazo/api secrets:infisical --prune     # also deletes unreferenced keys over an hour old
```

`ENCRYPTION_KEY` stays required. The full reference is in
[Self-host secrets](./self-host-secrets.md#keeping-in-app-secrets-in-infisical-optional).

## Staying mergeable with upstream

- Brand values live once in `packages/contracts/src/brand.js`. Internal ids (`@rakazo/*`,
  `RAKAZO_*`, storage keys, database names) stay as upstream.
- After merging `upstream/main`, run `pnpm brand:apply`, then `pnpm brand:check`. The tool covers
  the whole marketing site (`apps/www`), compose files, and a fixed list of other files. Lines
  containing `brand:keep` (the upstream credit) are never rewritten.
- Fork-only notes go in this file rather than in `CHANGELOG.md` or `AGENTS.md`, which upstream
  edits on every release.
- Billing from upstream stays off unless all `STRIPE_*` keys are set.

## Releases

A release commit bumps `apps/desktop/package.json` and is tagged `vX.Y.Z`. The tag publishes the
`app` and `computer` images under that version and `latest`; `main` publishes `edge`.

### v0.1.10

- Docker computers recover when the computer image is removed from the host, for example by
  `docker system prune`: the supervisor pulls the image again (or builds it) on the next request
  instead of failing until it restarts.
- Upstream sync: billing (off without Stripe), the mobile server-address screen, marketing guides,
  blog, and terms.
- The brand tool covers every file in `apps/www`, so new upstream pages are rebranded on merge.
- Infisical and OIDC are documented in this file, the README, and the self-host guide.
- SSO: the button appears only when the provider registered, the sign-in page retries a failed
  options request, existing accounts link by verified email (any email when SSO-only, ending
  earlier sessions), and the mobile app explains SSO-only servers.
- Infisical: versioned keys, safe migration while the app runs, hourly cleanup, rotation pickup
  for MCP sessions and integrations, logged refresh failures, and shutdown that stops polling.
