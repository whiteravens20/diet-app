import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md space-y-6 text-center">
        <p className="text-6xl font-semibold tracking-tight">404</p>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
        <div className="flex items-center justify-center">
          <Link href="/" className={buttonVariants({ variant: 'primary' })}>
            {t('home')}
          </Link>
        </div>
      </div>
    </div>
  );
}
