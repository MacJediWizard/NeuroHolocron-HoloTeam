// Writes PRODUCT_NAME into brand text that cannot import it (JSON, HTML, plain JS, YAML).
// Re-run after merging upstream, which reintroduces the upstream name in these files.
//   tsx scripts/apply-brand.ts          rewrite in place
//   tsx scripts/apply-brand.ts --check  exit 1 if any file still shows the upstream name
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND_DOMAIN,
  DESKTOP_APP_ID,
  MOBILE_APP_ID,
  OPERATOR_NAME,
  PRODUCT_NAME,
  SOURCE_REPO,
} from "../packages/contracts/src/brand.js";

const UPSTREAM_NAME = "Rakazo";
const [OWNER, REPO] = SOURCE_REPO.split("/");

const FILES = [
  ".env.example",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/self-host.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-macos-screenshot.yml",
  ".github/workflows/release-desktop.yml",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "SETUP_PROMPT.md",
  "apps/desktop/package.json",
  "apps/desktop/src/setup.html",
  "apps/desktop/src/setup.js",
  "apps/mobile/app.json",
  "apps/mobile/.maestro/notification-demo.yaml",
  "apps/mobile/.maestro/screenshots.yaml",
  "apps/mobile/.maestro/smoke.yaml",
  "apps/web/index.html",
  "apps/web/public/favicon.svg",
  "apps/web/public/site.webmanifest",
  "apps/www/astro.config.mjs",
  "apps/www/public/avatars/bot-avatar-blue.svg",
  "apps/www/public/avatars/bot-avatar-coordinator.svg",
  "apps/www/public/avatars/bot-avatar-coral.svg",
  "apps/www/public/avatars/bot-avatar-indigo.svg",
  "apps/www/public/avatars/bot-avatar-orange.svg",
  "apps/www/public/avatars/bot-avatar-pink.svg",
  "apps/www/public/avatars/bot-avatar-teal.svg",
  "apps/www/public/avatars/bot-avatar-violet.svg",
  "apps/www/public/brand/rakazo-mark.svg",
  "apps/www/public/favicon.svg",
  "apps/www/public/site.webmanifest",
  "apps/www/src/agent-content.test.ts",
  "apps/www/src/agent-content.ts",
  "apps/www/src/components/Footer.astro",
  "apps/www/src/components/HomePage.astro",
  "apps/www/src/components/Logo.astro",
  "apps/www/src/i18n/home.ts",
  "apps/www/src/layouts/BaseLayout.astro",
  "apps/www/src/middleware.test.ts",
  "apps/www/src/pages/404.astro",
  "apps/www/src/pages/about.astro",
  "apps/www/src/pages/privacy.astro",
  "apps/www/src/pages/support.astro",
  "apps/www/src/site.ts",
  "apps/www/src/waitlist.test.ts",
  "apps/www/src/waitlist.ts",
  "docs/self-host.md",
  "infra/compose/.env.images.example",
  "infra/compose/backup-prod.sh",
  "infra/compose/harden-host.sh",
  "infra/compose/install-images-pull-never.smoke.sh",
  "infra/compose/install-images.sh",
  "infra/sandboxes/computer/embed.html",
  "infra/sandboxes/computer/fluxbox.menu",
  "infra/sandboxes/computer/rakazo-browser.desktop",
  "infra/systemd/rakazo-backup.service",
  "infra/systemd/rakazo-backup.timer",
];

// Whole word only; asset file names such as Rakazo.icon are identifiers, not copy.
// Lines containing "brand:keep" (upstream credit) are left alone.
// App ids are store and OS identity, so they follow the brand rather than upstream.
// Installers, images, and desktop updates come from this repository's own releases.
// GHCR namespaces are lowercase.
const REWRITES: [RegExp, string][] = [
  [new RegExp(`\\b${UPSTREAM_NAME}\\b(?!\\.icon)`, "g"), PRODUCT_NAME],
  [/\bcom\.rakazo\.app\b/g, MOBILE_APP_ID],
  [/\bdev\.rakazo\.desktop\b/g, DESKTOP_APP_ID],
  [/\bsupport@rakazo\.com\b/g, `hello@${BRAND_DOMAIN}`],
  [/\brakazo\.com\b/g, BRAND_DOMAIN],
  [/\bghcr\.io\/elie222\/rakazo\b/g, `ghcr.io/${SOURCE_REPO.toLowerCase()}`],
  // A clone of this repository lands in a folder named after it, not after upstream.
  [/^cd rakazo$/gm, `cd ${REPO}`],
  [/\belie222\/rakazo\b/g, SOURCE_REPO],
  [/(\bowner"?:\s*"?)elie222\b/g, `$1${OWNER}`],
  [/(\brepo"?:\s*"?)rakazo\b/g, `$1${REPO}`],
  [/\bInbox Zero( Inc\.)?/g, OPERATOR_NAME],
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Upstream keeps adding compose overlays, so every one of them is covered.
for (const name of readdirSync(path.join(root, "infra/compose"))) {
  if (/^docker-compose.*\.yml$/.test(name)) FILES.push(`infra/compose/${name}`);
}
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const file of FILES) {
  const absolute = path.join(root, file);
  const source = readFileSync(absolute, "utf8");
  const branded = source
    .split("\n")
    .map((line) =>
      line.includes("brand:keep")
        ? line
        : REWRITES.reduce((text, [pattern, value]) => text.replace(pattern, value), line),
    )
    .join("\n");
  if (branded === source) continue;
  stale.push(file);
  if (!check) writeFileSync(absolute, branded);
}

if (check && stale.length > 0) {
  console.error(`Upstream brand text in:\n  ${stale.join("\n  ")}\nRun: pnpm brand:apply`);
  process.exit(1);
}
console.log(
  stale.length === 0
    ? "Brand text is current."
    : `Applied ${PRODUCT_NAME} to:\n  ${stale.join("\n  ")}`,
);
