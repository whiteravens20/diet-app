// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  /** 0-based index, used to stagger the entrance animation. */
  index?: number;
}

/** The tiles come in one after another: each waits a little longer than the one before it. */
const WAIT = ['', '[animation-delay:60ms]', '[animation-delay:120ms]', '[animation-delay:180ms]'];

/** Animated dashboard summary tile. */
export function StatCard({ label, value, hint, icon: Icon, index = 0 }: StatCardProps) {
  return (
    <div className={`rise-in h-full ${WAIT[index] ?? ''}`}>
      <Card className="h-full p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
          <span className="rounded-md bg-muted p-2 text-primary">
            <Icon size={20} aria-hidden />
          </span>
        </div>
      </Card>
    </div>
  );
}
