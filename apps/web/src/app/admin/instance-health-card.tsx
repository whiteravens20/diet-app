// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** How the instance stands, at a glance: what the panel's overview shows of its copy, its database, its tasks and its API. */
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ChevronRight, CircleCheck, CircleDashed, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminHealth, InstanceMirror } from '@/lib/admin-api';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { mirrorNeedsAttention } from './instance-files-card';

/** From this long a slow request is what the reader would notice: a model's answer takes as long, but one in twenty is no model's. */
const SLOW_MS = 2000;

type Tone = 'good' | 'warn' | 'plain';

const ICON = { good: CircleCheck, warn: TriangleAlert, plain: CircleDashed } as const;

function Row({
  label,
  tone,
  state,
  action,
  children,
}: {
  label: string;
  tone: Tone;
  state: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = ICON[tone];
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-sm font-medium',
              tone === 'good' && 'text-success',
              tone === 'warn' && 'text-warning',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {state}
          </span>
          {action}
        </div>
        {children}
      </dd>
    </div>
  );
}

const Detail = ({ children }: { children: ReactNode }) => (
  <p className="break-words text-xs text-muted-foreground">{children}</p>
);

export function InstanceHealthCard({
  health,
  failed,
  mirror,
  onRefresh,
  onToCatalogue,
}: {
  /** Null until it is read. */
  health: AdminHealth | null;
  failed: boolean;
  mirror: InstanceMirror | null;
  onRefresh: () => void;
  onToCatalogue: () => void;
}) {
  const t = useTranslations('admin.health');
  const tMirror = useTranslations('admin.mirror');
  const tTabs = useTranslations('admin.tabs');
  const fmt = useFormat();
  const megabytes = (bytes: number) => fmt.unit(bytes / 1_048_576, 'megabyte', 0);

  const requestsTone = (requests: AdminHealth['requests']): Tone =>
    requests.counted === 0
      ? 'plain'
      : requests.serverErrors > 0 || (requests.p95Ms ?? 0) > SLOW_MS
        ? 'warn'
        : 'good';
  const requestsState = (requests: AdminHealth['requests']): string =>
    requests.counted === 0
      ? t('requestsNone')
      : requests.serverErrors > 0
        ? t('requestsErrors')
        : (requests.p95Ms ?? 0) > SLOW_MS
          ? t('requestsSlow')
          : t('requestsGood');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('title')}</CardTitle>
          <div className="flex items-center gap-3">
            {health && (
              <span className="text-xs text-muted-foreground">
                {t('checked', { when: fmt.moment(health.checkedAt) })}
              </span>
            )}
            <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t('refresh')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {failed && !health && (
          <p role="alert" className="text-sm text-destructive">
            {t('failed')}
          </p>
        )}
        {!failed && !health && <Skeleton className="h-40" aria-label={t('title')} role="status" />}
        {health && (
          <dl className="divide-y divide-border">
            {mirror && (
              <Row
                label={t('mirror')}
                tone={
                  mirrorNeedsAttention(mirror)
                    ? 'warn'
                    : mirror.state === 'current'
                      ? 'good'
                      : 'plain'
                }
                state={tMirror(`state.${mirror.state}`)}
                action={
                  <button
                    type="button"
                    onClick={onToCatalogue}
                    className="inline-flex min-h-6 items-center gap-1 text-xs text-muted-foreground hover:underline"
                  >
                    {tTabs('catalogue')}
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                }
              >
                {mirror.failure && <Detail>{tMirror(`failure.${mirror.failure}`)}</Detail>}
                {mirror.pushedAt && (
                  <Detail>{t('mirrorPushed', { when: fmt.moment(mirror.pushedAt) })}</Detail>
                )}
              </Row>
            )}
            <Row
              label={t('database')}
              tone={health.database.up ? 'good' : 'warn'}
              state={health.database.up ? t('databaseUp') : t('databaseDown')}
            >
              {health.database.up && (
                <Detail>
                  {t('databaseDetail', {
                    ms: fmt.number(health.database.pingMs ?? 0),
                    size: megabytes(health.database.bytes ?? 0),
                  })}
                </Detail>
              )}
            </Row>
            <Row
              label={t('worker')}
              tone={
                health.worker.state === 'ok'
                  ? 'good'
                  : health.worker.state === 'none'
                    ? 'plain'
                    : 'warn'
              }
              state={
                health.worker.state === 'ok'
                  ? t('workerOk')
                  : health.worker.state === 'failing'
                    ? t('workerFailing')
                    : health.worker.state === 'silent'
                      ? t('workerSilent')
                      : t('workerNone')
              }
            >
              {health.worker.lastPassAt && (
                <Detail>{t('workerLast', { when: fmt.moment(health.worker.lastPassAt) })}</Detail>
              )}
              {health.worker.state === 'failing' && (
                <Detail>{t('workerFailed', { count: health.worker.failedJobs })}</Detail>
              )}
              {health.worker.state === 'silent' && <Detail>{t('workerSilentHint')}</Detail>}
              {(health.worker.state === 'failing' || health.worker.state === 'silent') && (
                <Detail>{t('workerLogs')}</Detail>
              )}
            </Row>
            <Row label={t('api')} tone="good" state={t('apiUp')}>
              <Detail>
                {t('apiDetail', {
                  version: health.api.version,
                  since: fmt.moment(health.api.startedAt),
                  memory: megabytes(health.api.memoryBytes),
                })}
              </Detail>
            </Row>
            <Row
              label={t('requests')}
              tone={requestsTone(health.requests)}
              state={requestsState(health.requests)}
            >
              {health.requests.counted > 0 && (
                <Detail>
                  {t('requestsDetail', {
                    median: fmt.number(health.requests.medianMs ?? 0),
                    p95: fmt.number(health.requests.p95Ms ?? 0),
                    errors: fmt.number(health.requests.serverErrors),
                    counted: fmt.number(health.requests.counted),
                  })}
                </Detail>
              )}
              <Detail>{t('requestsNote')}</Detail>
            </Row>
            <Row
              label={t('ai')}
              tone={
                !health.ai.configured
                  ? 'plain'
                  : health.ai.used >= health.ai.limit
                    ? 'warn'
                    : 'good'
              }
              state={
                !health.ai.configured
                  ? t('aiOff')
                  : t(health.ai.used >= health.ai.limit ? 'aiReached' : 'aiUsed', {
                      used: fmt.number(health.ai.used),
                      limit: fmt.number(health.ai.limit),
                    })
              }
            />
            <Row
              label={t('mail')}
              tone={health.mail.configured ? 'good' : 'plain'}
              state={health.mail.configured ? t('mailOn') : t('mailOff')}
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
