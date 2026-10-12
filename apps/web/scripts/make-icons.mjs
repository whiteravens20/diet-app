// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/*
 * Makes the bitmap icons of the web application from its one drawing,
 * `public/icon.svg`. Run it from `apps/web` when the drawing changes, and
 * commit what it writes:
 *
 *   node scripts/make-icons.mjs
 *
 * A browser that installs the application asks for bitmaps of 192 and 512
 * pixels; a phone that puts it on its home screen cuts the icon to a shape of
 * its own (the "maskable" one, whose drawing keeps clear of the edges), and
 * iOS takes one of 180 pixels without transparency.
 *
 * It draws with `sharp`, which the framework brings for its own pictures.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const folder = new URL('../public/', import.meta.url);
const drawing = readFileSync(new URL('icon.svg', folder), 'utf8');
const BOX = 64;

// The drawing is a rounded square with a figure on it. The same figure on a square without corners, drawn smaller
// so that it stays inside whatever shape the square is cut to.
const [, inside] = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(drawing);
const [, colour] = /<rect[^>]*fill="([^"]+)"/.exec(inside);
const figure = inside.replace(/<rect[^>]*\/>/, '');
const toTheEdge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}"><rect width="${BOX}" height="${BOX}" fill="${colour}"/><g transform="translate(${BOX / 2} ${BOX / 2}) scale(0.78) translate(${-BOX / 2} ${-BOX / 2})">${figure}</g></svg>`;

/** Draw `svg` as a square bitmap of `size` pixels. */
const drawn = (svg, size, name) =>
  sharp(Buffer.from(svg), { density: (72 * size) / BOX })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(fileURLToPath(new URL(name, folder)));

await drawn(drawing, 192, 'icon-192.png');
await drawn(drawing, 512, 'icon-512.png');
await drawn(toTheEdge, 512, 'icon-maskable-512.png');
await drawn(toTheEdge, 180, 'apple-touch-icon.png');
console.log('icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png');
