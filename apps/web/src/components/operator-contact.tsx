// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
'use client';

import { useConfig } from '@/lib/use-config';

/**
 * The e-mail address of whoever runs this instance, as published through the
 * API's public configuration, or `notPublished` when there is none.
 */
export function OperatorContact({ notPublished }: { notPublished: string }) {
  const { data: config } = useConfig();
  const contact = config?.instance.operatorContact;
  if (!contact) return <p className="text-sm text-muted-foreground/70">{notPublished}</p>;
  return (
    <p>
      <a href={`mailto:${contact}`} className="text-primary underline-offset-2 hover:underline">
        {contact}
      </a>
    </p>
  );
}
