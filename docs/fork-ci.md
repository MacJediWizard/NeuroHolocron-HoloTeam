# Fork CI switches

Upstream CI assumes accounts this fork does not have yet. These jobs are off
until the matching accounts exist; everything else runs as upstream.

| Job | Off because | Turn on |
|---|---|---|
| `release-desktop` (signed desktop apps on `v*` tags) | No Apple signing or notarization secrets | Add the repo secrets `DESKTOP_MAC_CSC_LINK`, `DESKTOP_MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, then `gh workflow enable release-desktop` |
| `publish-mobile-update` in `ci.yml` (Expo OTA) | No Expo project or `EXPO_TOKEN` | Point the mobile app at this fork's Expo project, add the `EXPO_TOKEN` secret, then `gh variable set MOBILE_OTA_ENABLED --body true` |
| `publish Playwright report` (E2E report upload) | No S3 report bucket | Add the secrets `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and the variables `S3_REGION`, `S3_BUCKET`, `S3_ENDPOINT`, `PLAYWRIGHT_PUBLIC_BASE_URL`, then `gh variable set PLAYWRIGHT_REPORT_ENABLED --body true` |
| `deploy-production` in `ci.yml` (upstream's own host) | Not used; deployments pull the published images | `gh variable set PRODUCTION_DEPLOY_ENABLED --body true` with the `PRODUCTION_SSH_*` secrets |

Server images (`publish-server-image`) need no extra accounts: `main` publishes
`edge`, and `v*` tags publish the version and `latest`.
