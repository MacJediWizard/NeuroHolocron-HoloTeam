# Legiara fork

Legiara is a fork of [Rakazo](https://github.com/elie222/rakazo). This page lists what the fork adds
and how it stays mergeable with upstream. Upstream changes are in [CHANGELOG.md](../CHANGELOG.md).

## Fork features

| Feature | Configure with | Docs |
| --- | --- | --- |
| SSO admits users without the signup allowlist by default (upstream SSO otherwise) | `OIDC_ALLOW_SIGNUP_BYPASS` (defaults to `true`) | [Self-hosting: SSO](./self-host.md#optional-openid-connect-sso) |
| Shared Spaces: provider groups add members to a Space that they share with its owner | `OIDC_GROUP_SPACES`, `OIDC_GROUPS_CLAIM` | [Self-hosting: Shared Spaces](./self-host.md#shared-spaces-from-provider-groups) |
| In-app secrets (model keys, integration credentials, bot secrets) kept in Infisical instead of Postgres | `SECRET_STORE=infisical` and `INFISICAL_*` | [Infisical: Legiara compatibility](./infisical-secrets.md#legiara-compatibility) |
| Error reporting to Sentry or a Sentry-compatible collector such as GlitchTip, from the server and the web app | `SENTRY_DSN`, `SENTRY_BROWSER_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | [Self-hosting: Logging](./self-host.md#logging) |
| Images, installer, and desktop updates published from this repository | `SOURCE_REPO` in `packages/contracts/src/brand.js` | [Published images and tags](./self-host.md#published-images-and-tags) |
| CI that runs without upstream's paid services | Repository variables | [Fork CI](./fork-ci.md) |

Every fork feature is off unless configured, so a deployment without these variables behaves like
upstream.

## Infisical secret store

The Infisical store is upstream's. The fork keeps it compatible with stores set up by earlier
Legiara releases and with other services that share the folder: it accepts `INFISICAL_SITE_URL`,
`INFISICAL_SECRET_PATH` and `INFISICAL_REFRESH_SECONDS` as older names, writes keys as
`SECRET_<record id>__v<time>_<random>`, and reads those keys, unversioned `SECRET_<record id>`
keys and upstream `infisical:v1:` refs. Setup, migration and rollback are in
[Infisical setup, migration, and rollback](./infisical-secrets.md).

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
