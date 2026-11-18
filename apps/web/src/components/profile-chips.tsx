// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { Profile } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/use-format';

/**
 * Whose page it is, where an account has more than one profile: one button a profile, the one shown pressed. Every
 * page that is a profile's own picks it so; nothing at all for an account of one profile.
 */
export function ProfileChips({
  profiles,
  active,
  onPick,
}: {
  profiles: Pick<Profile, 'id' | 'name'>[];
  active: string | null;
  onPick: (id: string) => void;
}) {
  const t = useTranslations('common');
  const fmt = useFormat();
  if (profiles.length < 2) return null;
  return (
    <div role="group" aria-label={t('profileChoice')} className="flex flex-wrap gap-2">
      {profiles.map((profile) => (
        <Button
          key={profile.id}
          type="button"
          size="sm"
          variant={profile.id === active ? 'primary' : 'outline'}
          aria-pressed={profile.id === active}
          onClick={() => onPick(profile.id)}
          // A name as long as one can be breaks inside the chip rather than stick out of the page.
          className="h-auto min-h-8 max-w-full py-1 text-left [overflow-wrap:anywhere]"
        >
          {fmt.text(profile.name)}
        </Button>
      ))}
    </div>
  );
}
