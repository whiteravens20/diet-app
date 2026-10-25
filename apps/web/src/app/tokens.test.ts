// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The colour tokens of `globals.css`, held to WCAG 2.2 level AA in every
 * palette, light and dark: text 4.5:1 against what it is written on, the
 * edge of a control 3:1 against what surrounds it.
 *
 * The stylesheet is read as text and its `oklch()` values are worked out
 * here, so a value changed there is judged at once, without a browser.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Oklch = [lightness: number, chroma: number, hue: number];
type Rgb = [number, number, number];

/** OKLCH to sRGB with gamma, each part between 0 and 1: what a browser paints. */
function painted([l, c, h]: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
  return linear.map((v) => {
    const clipped = Math.min(1, Math.max(0, v));
    return clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(one: Rgb, other: Rgb): number {
  const [lighter, darker] = [luminance(one), luminance(other)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/** `top` at `alpha` over `under`, blended as a browser blends: in sRGB. */
const over = (top: Rgb, under: Rgb, alpha: number): Rgb =>
  top.map((v, i) => v * alpha + under[i]! * (1 - alpha)) as Rgb;

const PALETTES = ['default', 'ocean', 'forest', 'sunset', 'mono', 'rose'] as const;
const MODES = ['light', 'dark'] as const;

/** The tokens of every block of the stylesheet, by palette and mode. */
function blocks(): Record<string, Record<string, Oklch>> {
  const css = readFileSync(join(import.meta.dirname, 'globals.css'), 'utf8');
  const found: Record<string, Record<string, Oklch>> = {};
  for (const block of css.matchAll(
    /^(:root|\.dark)(?:\[data-palette='(\w+)'\])?\s*\{([^}]*)\}/gm,
  )) {
    const tokens: Record<string, Oklch> = {};
    for (const token of block[3]!.matchAll(/--([\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)) {
      tokens[token[1]!] = [Number(token[2]), Number(token[3]), Number(token[4])];
    }
    found[`${block[2] ?? 'default'} ${block[1] === '.dark' ? 'dark' : 'light'}`] = tokens;
  }
  return found;
}

/** What a palette paints in a mode: its own tokens over the default palette's. */
function paletteIn(palette: string, mode: string): Record<string, Rgb> {
  const all = blocks();
  const tokens = { ...all[`default ${mode}`], ...all[`${palette} ${mode}`] };
  return Object.fromEntries(Object.entries(tokens).map(([name, value]) => [name, painted(value)]));
}

const SURFACES = ['background', 'card', 'muted'] as const;

/** Every pair that falls short of `least`, as `<palette> <mode>: <text> on <surface> <ratio>`. */
function short(
  pairs: (colours: Record<string, Rgb>) => [name: string, text: Rgb, behind: Rgb][],
  least: number,
): string[] {
  return PALETTES.flatMap((palette) =>
    MODES.flatMap((mode) =>
      pairs(paletteIn(palette, mode))
        .filter(([, text, behind]) => contrast(text, behind) < least)
        .map(
          ([name, text, behind]) =>
            `${palette} ${mode}: ${name} ${contrast(text, behind).toFixed(2)}`,
        ),
    ),
  );
}

describe('the colour tokens', () => {
  it('are read: every palette has its light and its dark block', () => {
    const found = blocks();

    for (const palette of PALETTES)
      for (const mode of MODES)
        expect(Object.keys(found[`${palette} ${mode}`] ?? {}), `${palette} ${mode}`).not.toEqual(
          [],
        );
    expect(Object.keys(found['default light']!)).toEqual(
      expect.arrayContaining([
        'background',
        'card',
        'muted',
        'foreground',
        'muted-foreground',
        'primary',
        'input',
        'warning',
        'success',
        'destructive',
      ]),
    );
  });

  it('keep text readable on every surface it is written on', () => {
    expect(
      short(
        (c) =>
          SURFACES.flatMap((surface) => [
            [`foreground on ${surface}`, c.foreground!, c[surface]!],
            [`muted-foreground on ${surface}`, c['muted-foreground']!, c[surface]!],
            [`primary on ${surface}`, c.primary!, c[surface]!],
            [`destructive on ${surface}`, c.destructive!, c[surface]!],
            [`warning on ${surface}`, c.warning!, c[surface]!],
            [`success on ${surface}`, c.success!, c[surface]!],
          ]),
        4.5,
      ),
    ).toEqual([]);
  });

  it('keep the text of a button readable on the button', () => {
    expect(
      short(
        (c) => [
          ['primary-foreground on primary', c['primary-foreground']!, c.primary!],
          ['destructive-foreground on destructive', c['destructive-foreground']!, c.destructive!],
        ],
        4.5,
      ),
    ).toEqual([]);
  });

  it('keep the text of a notice readable on a tint of its own colour', () => {
    // A notice is written in its colour on that colour at a tenth, over the page or over a card.
    expect(
      short(
        (c) =>
          (['warning', 'success', 'destructive'] as const).flatMap((tone) =>
            (['background', 'card'] as const).map((surface): [string, Rgb, Rgb] => [
              `${tone} on its tint over ${surface}`,
              c[tone]!,
              over(c[tone]!, c[surface]!, 0.1),
            ]),
          ),
        4.5,
      ),
    ).toEqual([]);
  });

  it('keep the edge of a control and the ring of the focus apart from what surrounds them', () => {
    expect(
      short(
        (c) =>
          SURFACES.flatMap((surface) => [
            [`input on ${surface}`, c.input!, c[surface]!],
            [`ring on ${surface}`, c.ring!, c[surface]!],
          ]),
        3,
      ),
    ).toEqual([]);
  });

  it('are judged by a measure that knows black from white', () => {
    expect(contrast(painted([0, 0, 0]), painted([1, 0, 0]))).toBeCloseTo(21, 1);
    expect(contrast(painted([0.5, 0, 0]), painted([0.5, 0, 0]))).toBe(1);
    // Mid grey on white, as a colour picker gives it: #777777 is 4.48:1.
    expect(contrast([0x77 / 255, 0x77 / 255, 0x77 / 255], [1, 1, 1])).toBeCloseTo(4.48, 2);
  });
});
