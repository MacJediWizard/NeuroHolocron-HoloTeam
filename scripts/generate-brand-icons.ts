// Generates every platform icon from the single brand master image.
//   tsx scripts/generate-brand-icons.ts
// Replace packages/ui-tokens/assets/brand-icon.png (square, opaque) and re-run.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { PRODUCT_NAME } from "../packages/contracts/src/brand.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (file: string) => path.join(root, file);
const MASTER = at("packages/ui-tokens/assets/brand-icon.png");

const full = (size: number) => sharp(MASTER).resize(size, size).png().toBuffer();

async function onCanvas(canvas: number, image: Buffer) {
  const { width = 0 } = await sharp(image).metadata();
  const offset = Math.round((canvas - width) / 2);
  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: image, left: offset, top: offset }])
    .png()
    .toBuffer();
}

async function rounded(size: number, radius: number) {
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`,
  );
  return sharp(await full(size))
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

// White shape on transparent, alpha from brightness: Android monochrome and notification icons.
async function silhouette(size: number) {
  const { data, info } = await sharp(MASTER)
    .resize(size, size)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const brightness = Math.max(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    out.fill(255, i * 4, i * 4 + 3);
    out[i * 4 + 3] = Math.min(255, Math.max(0, (brightness - 32) * 2));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

// ICO container holding PNG frames (supported since Windows Vista and by every browser).
async function ico(sizes: number[]) {
  const frames = await Promise.all(sizes.map(full));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], entry);
    header.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  return Buffer.concat([header, ...frames]);
}

async function svgFavicon() {
  const png = (await full(128)).toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128" role="img" aria-labelledby="title">
  <title id="title">${PRODUCT_NAME} mark</title>
  <image width="128" height="128" href="data:image/png;base64,${png}" />
</svg>
`;
}

// 1200x630 link preview: mark on the left, name and tagline on the right.
async function socialCard() {
  const text = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <style>text { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; fill: #f5f5f5; }</style>
  <text x="600" y="290" font-size="104" font-weight="700">${PRODUCT_NAME}</text>
  <text x="604" y="370" font-size="40" fill-opacity="0.75">AI teammates you actually own</text>
</svg>`);
  return sharp({ create: { width: 1200, height: 630, channels: 3, background: "#000" } })
    .composite([
      { input: await full(520), left: 40, top: 55 },
      { input: text, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}

const outputs: Record<string, () => Promise<Buffer | string>> = {
  "packages/ui-tokens/assets/Rakazo.icon/Assets/brand-icon.png": () => full(1024),
  "apps/desktop/assets/icon.png": () => full(1024),
  "apps/desktop/assets/icon-macos.png": async () => onCanvas(1024, await rounded(824, 185)),
  "apps/desktop/assets/icon.ico": () => ico([256]),
  "apps/mobile/assets/icon.png": () => full(1024),
  "apps/mobile/assets/adaptive-icon.png": async () => onCanvas(1024, await full(704)),
  "apps/mobile/assets/monochrome-icon.png": async () => onCanvas(1024, await silhouette(704)),
  "apps/mobile/assets/icon-background.png": () =>
    sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#000" } })
      .png()
      .toBuffer(),
  "apps/mobile/assets/notification-icon.png": async () => onCanvas(96, await silhouette(88)),
  "apps/mobile/assets/splash-icon.png": async () => onCanvas(1024, await rounded(620, 140)),
  "apps/mobile/assets/favicon.png": () => full(48),
  "apps/web/public/apple-touch-icon.png": () => full(180),
  "apps/web/public/favicon-16x16.png": () => full(16),
  "apps/web/public/favicon-32x32.png": () => full(32),
  "apps/web/public/favicon.ico": () => ico([16, 32, 48]),
  "apps/web/public/favicon.svg": svgFavicon,
  "apps/web/public/icon-192.png": () => full(192),
  "apps/web/public/icon-512.png": () => full(512),
  "apps/www/public/apple-touch-icon.png": () => full(180),
  "apps/www/public/favicon-16x16.png": () => full(16),
  "apps/www/public/favicon-32x32.png": () => full(32),
  "apps/www/public/favicon.ico": () => ico([16, 32, 48]),
  "apps/www/public/favicon.svg": svgFavicon,
  "apps/www/public/icon-192.png": () => full(192),
  "apps/www/public/icon-512.png": () => full(512),
  "apps/www/public/brand/mark.png": async () => rounded(144, 32),
  "apps/www/public/og-image.png": socialCard,
};

for (const [file, render] of Object.entries(outputs)) {
  writeFileSync(at(file), await render());
  console.log(`wrote ${file}`);
}
