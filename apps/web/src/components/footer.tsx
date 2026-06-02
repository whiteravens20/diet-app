import { BookOpen, Code2, Heart, Scale } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

const SOURCE_URL = 'https://github.com/whiteravens20/diet-app';
const DOCS_URL = 'https://wrservices.link';
const DEFAULT_SUPPORT_URL = 'https://ko-fi.com/whiteravens20';
const WHITE_RAVENS_HOME = 'https://whiteravens.net';

type FooterLink = {
  key: 'source' | 'docs' | 'terms' | 'support';
  href: string;
  external: boolean;
  Icon: typeof Code2;
};

function getLinks(): FooterLink[] {
  const supportUrl = process.env.NEXT_PUBLIC_SUPPORT_URL ?? DEFAULT_SUPPORT_URL;
  return [
    { key: 'source', href: SOURCE_URL, external: true, Icon: Code2 },
    { key: 'docs', href: DOCS_URL, external: true, Icon: BookOpen },
    { key: 'terms', href: '/terms', external: false, Icon: Scale },
    { key: 'support', href: supportUrl, external: true, Icon: Heart },
  ];
}

/**
 * Persistent footer mounted at the root layout so both `(auth)` and `(app)`
 * route groups inherit it. Links separated by `|` glyphs at `sm`+; on narrow
 * screens the separators collapse and groups wrap vertically.
 */
export function Footer() {
  const t = useTranslations('footer');
  // Blank / unset → hide the chip entirely. Operators opt in by setting
  // NEXT_PUBLIC_APP_VERSION (e.g. to the package version, a release tag, a
  // CI SHA) and opt out by leaving it empty.
  const version = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
  const links = getLinks();

  return (
    <footer className="mt-auto border-t border-border/60 px-6 py-5 text-xs text-muted-foreground">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-2">
        <ul className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
          {links.map((link, idx) => {
            const { Icon } = link;
            const anchor = (
              <span className="inline-flex items-center gap-1.5 hover:text-foreground">
                <Icon
                  className="h-3.5 w-3.5 pointer-events-none"
                  aria-hidden
                />
                <span>{t(link.key)}</span>
              </span>
            );
            return (
              <li key={link.key} className="inline-flex items-center gap-3">
                {link.external ? (
                  <a href={link.href} target="_blank" rel="noreferrer">
                    {anchor}
                  </a>
                ) : (
                  <Link href={link.href}>{anchor}</Link>
                )}
                {idx < links.length - 1 && (
                  <span aria-hidden className="hidden text-border sm:inline">
                    |
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="flex items-center gap-2">
          <a
            href={WHITE_RAVENS_HOME}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            {t('copyright')}
          </a>
          {version && (
            <>
              <span aria-hidden className="text-border">
                ·
              </span>
              <span className="text-muted-foreground/70">v{version}</span>
            </>
          )}
        </p>
      </div>
    </footer>
  );
}
