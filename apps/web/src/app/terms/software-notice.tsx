// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { OperatorContact } from '@/components/operator-contact';
import { ATTRIBUTION, ATTRIBUTION_URL, SOURCE_URL } from '@/lib/project-links';

/** The id of the notice, for the page's outline. */
export const SOFTWARE_NOTICE_ID = 'software';

const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

function linkTo(href: string) {
  return function Linked(chunks: ReactNode) {
    return (
      <a href={href} className="text-primary underline underline-offset-2">
        {chunks}
      </a>
    );
  };
}

/**
 * What the application says of itself under the terms of every instance, whatever its
 * operator wrote there: the legal notices its licence and the additional term of NOTICE
 * require, with the attribution and the address of the original source; where to report
 * a mistake in the software; and how to reach the operator.
 */
export function SoftwareNotice() {
  const t = useTranslations('terms.software');
  return (
    <section
      id={SOFTWARE_NOTICE_ID}
      aria-labelledby={`${SOFTWARE_NOTICE_ID}-title`}
      className="scroll-mt-10 space-y-3 border-t border-border/60 pt-8 leading-relaxed text-muted-foreground"
    >
      <h2
        id={`${SOFTWARE_NOTICE_ID}-title`}
        className="text-xl font-semibold tracking-tight text-foreground"
      >
        {t('title')}
      </h2>
      <p>
        {t.rich('notice', {
          attribution: ATTRIBUTION,
          address: ATTRIBUTION_URL,
          source: linkTo(ATTRIBUTION_URL),
        })}
      </p>
      <p>{t.rich('licence', { gnu: linkTo(LICENCE_URL) })}</p>
      <p>{t('warranty')}</p>
      <p>{t('changed')}</p>
      <p>
        {t.rich('problems', {
          issues: linkTo(`${SOURCE_URL}/issues`),
          security: linkTo(`${SOURCE_URL}/security/policy`),
        })}
      </p>
      <p>{t('operator')}</p>
      <OperatorContact notPublished={t('operatorNotSet')} />
    </section>
  );
}
