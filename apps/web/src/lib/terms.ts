// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { holdLetters, holdsLetters } from './held-letters';

/**
 * The terms of service of an instance are Markdown files its operator writes: `TOS.md`,
 * in whatever language the operator chose, and beside it a translation for an interface
 * language, named by its code (`TOS.pl.md`). An instance whose operator wrote none shows
 * the template that comes with the application, which says that it is one.
 *
 * They are turned into HTML here, on the server, and the page puts that HTML in as it is.
 * So two things a Markdown file can carry are taken out: raw HTML is shown as the text it
 * is, and a link or a picture keeps its address only when that plainly is a web or mail
 * address or a path of the site. The content security policy would run no script from
 * it either way.
 */

/** Where the operator's files are: the directory the Compose files mount. */
const OPERATOR_DIR = '/terms';
/**
 * Where the template is: `terms/` of the repository, which the image keeps beside the
 * web server. The development server and the built one both run in the web app's own
 * directory, two levels under it.
 */
const TEMPLATE_DIR = path.resolve(process.cwd(), '..', '..', 'terms');

/** One document of terms, as the page shows it. */
interface TermsDocument {
  html: string;
  /** The language it is written in, where that is known: a translation's code, English for the template. */
  lang: string | null;
  /** Its second-level headings in order, with the ids the HTML gives them. */
  outline: { id: string; title: string }[];
}

/** The terms of an instance: `TOS.md`, and its translations by language code. */
interface Terms {
  terms: TermsDocument;
  translations: Record<string, TermsDocument>;
}

/** A translation is named for a two-letter language code, as the interface languages are. */
const TRANSLATION = /^TOS\.([a-z]{2})\.md$/;

/**
 * Whether an address may be kept as it stands. Judged by how it begins, because that
 * alone decides what a browser makes of it: a web or mail scheme spelled out, or a
 * character that can only start a path, a query or a fragment of this site. Everything
 * else is refused, without an attempt to work out which scheme it hides: an address can
 * spell `javascript:` with entities, control characters and mixed case in more ways than
 * a check could list.
 */
function isSafeUrl(href: string): boolean {
  return /^(https?:\/\/|mailto:|[/#?]|\.\.?\/)/i.test(href);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * One Markdown document as HTML, with the outline of its second-level headings. In a
 * language known to be Polish its words of one letter are held to the next, as every
 * text the application shows is: in the text between the tags alone.
 */
export function renderTerms(markdown: string, lang: string | null = null): TermsDocument {
  const outline: TermsDocument['outline'] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      // `false` hands the token back to the default renderer.
      link({ href, tokens }) {
        return isSafeUrl(href) ? false : this.parser.parseInline(tokens);
      },
      image({ href, text }) {
        return isSafeUrl(href) ? false : escapeHtml(text);
      },
      heading({ tokens, depth }) {
        if (depth !== 2) return false;
        const id = `section-${outline.length + 1}`;
        outline.push({ id, title: this.parser.parseInline(tokens, this.parser.textRenderer) });
        return `<h2 id="${id}">${this.parser.parseInline(tokens)}</h2>\n`;
      },
    },
  });
  const html = marked.parse(markdown, { async: false });
  if (lang === null) return { html, outline, lang };
  return {
    html: heldHtml(html, lang),
    outline: outline.map((entry) => ({ ...entry, title: holdLetters(entry.title, lang) })),
    lang,
  };
}

/** A word of one letter that ends a run of text, its space after it. */
const LETTER_AT_END = /(?:^|[\s(„"»])[wziaouWZIAOU] $/u;

/**
 * HTML with the words of one letter of its text held to the next: in the text between the
 * tags, and where such a word ends the text before a tag, to the text after it ("i <a>").
 */
function heldHtml(html: string, lang: string): string {
  const parts = html.split(/(<[^>]*>)/);
  return parts
    .map((part, index) => {
      if (part.startsWith('<')) return part;
      const held = holdLetters(part, lang);
      const after = parts.slice(index + 1).find((next) => !next.startsWith('<'));
      return holdsLetters(lang) &&
        after !== undefined &&
        /^\S/u.test(after) &&
        LETTER_AT_END.test(held)
        ? `${held.slice(0, -1)}\u00a0`
        : held;
    })
    .join('');
}

/**
 * `TOS.md` and its translations in `dir`, or null when it holds no `TOS.md` to read.
 * `TOS.md` is in the language `lang` names, or in one nobody has said.
 */
export function readTerms(dir: string, lang: string | null = null): Terms | null {
  let markdown: string;
  try {
    markdown = readFileSync(path.join(dir, 'TOS.md'), 'utf8');
  } catch {
    return null;
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // A directory that can be read from but not listed: `TOS.md` alone.
  }
  const translations: Record<string, TermsDocument> = {};
  for (const name of names) {
    const code = TRANSLATION.exec(name)?.[1];
    if (!code) continue;
    try {
      translations[code] = renderTerms(readFileSync(path.join(dir, name), 'utf8'), code);
    } catch {
      // Docker puts a directory where a file it was told to mount is missing.
    }
  }
  return { terms: renderTerms(markdown, lang), translations };
}

let loaded: Terms | undefined;

/**
 * The terms the page shows in `locale`: the operator's, or the template where there are
 * none. They are read once a process, so a change of the files shows after the web
 * server is started again.
 */
export function termsFor(locale: string): TermsDocument {
  if (!loaded) {
    const own = readTerms(OPERATOR_DIR);
    if (!own) {
      console.warn(
        `[terms] No TOS.md to read in ${OPERATOR_DIR}: the page shows the template that comes with the application.`,
      );
    }
    // The template is written in English.
    const terms = own ?? readTerms(TEMPLATE_DIR, 'en');
    if (!terms)
      throw new Error(`The template of the terms of service is missing from ${TEMPLATE_DIR}.`);
    loaded = terms;
  }
  return loaded.translations[locale] ?? loaded.terms;
}
