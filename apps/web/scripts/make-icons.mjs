// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/*
 * Makes the web application's icons from the mark's drawings in `brand/`: the
 * icon whole (`icon.png`, the symbol on its tile), the symbol alone on a
 * transparent ground (`symbol.png`), and the favicon's flat glyph
 * (`glyph.png`, green on white). Run it from `apps/web` when a drawing
 * changes, and commit what it writes:
 *
 *   node scripts/make-icons.mjs
 *
 * A browser that installs the application asks for bitmaps of 192 and 512
 * pixels; a phone that puts it on its home screen cuts the icon to a shape of
 * its own (the "maskable" one, whose symbol keeps clear of the edges), and iOS
 * takes one of 180 pixels without transparency. A tab shows the favicon at 16,
 * 32 or 48 pixels, all three in one file.
 *
 * It draws with `sharp`, which the framework brings for its own pictures.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const brand = (name) => fileURLToPath(new URL(`../brand/${name}`, import.meta.url));
const publicFile = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

/** Where the symbol lies on its 1024 px canvas: the centre of its box, and its farthest point from that centre. */
const SYMBOL = { x: 528, y: 513, reach: 522 };
/** The mark's green, the favicon's glyph filled with it. */
const GREEN = [0x2f, 0x9e, 0x6f];
/** The icons in 256 colours: a fifth of the weight in full colour, and no difference to see at the sizes they are shown. */
const PALETTE = { compressionLevel: 9, palette: true, quality: 100, effort: 10 };

/** The tile's ground, lighter at the top left, as a square of `size` pixels. */
const ground = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4fb381"/><stop offset="0.5" stop-color="#1c7a54"/><stop offset="1" stop-color="#034632"/></linearGradient></defs><rect width="${size}" height="${size}" fill="url(#g)"/></svg>`,
  );

/** The symbol on the tile's ground, its farthest point `reach` of the square's side from the centre. */
async function onGround(size, reach, name) {
  const scaled = Math.round((1024 * reach * size) / SYMBOL.reach);
  const symbol = await sharp(brand('symbol.png')).resize(scaled, scaled).toBuffer();
  const left = Math.round(size / 2 - (SYMBOL.x * scaled) / 1024);
  const top = Math.round(size / 2 - (SYMBOL.y * scaled) / 1024);
  await sharp(ground(size))
    .composite([{ input: symbol, left, top }])
    .flatten()
    .png(PALETTE)
    .toFile(publicFile(name));
}

/** The glyph in the mark's green on a transparent ground, `size` pixels square: its opacity is the drawing's darkness. */
async function glyph(size) {
  const { data, info } = await sharp(brand('glyph.png'))
    .resize(size, size)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const light = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
    rgba.set(GREEN, i * 4);
    rgba[i * 4 + 3] = Math.min(255, Math.round((255 - light) * 2));
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** An .ico of PNG images, as browsers read one: its header, one entry for each image, then the images. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

for (const size of [192, 512]) {
  await sharp(brand('icon.png'))
    .resize(size, size)
    .png(PALETTE)
    .toFile(publicFile(`icon-${size}.png`));
}
// Inside the circle of 80 percent a maskable icon keeps whole; inside the rounded square iOS cuts.
await onGround(512, 0.38, 'icon-maskable-512.png');
await onGround(180, 0.42, 'apple-touch-icon.png');
const sizes = [16, 32, 48];
writeFileSync(
  publicFile('favicon.ico'),
  ico(await Promise.all(sizes.map(async (size) => ({ size, png: await glyph(size) })))),
);
console.log('icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png, favicon.ico');
