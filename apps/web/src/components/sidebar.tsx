// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarRange, LayoutDashboard, LogOut, Menu, Package, Settings, ShoppingBasket, Soup, UserRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { session } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ThemeToggle } from '@/components/theme-toggle';
import { AiChip } from '@/components/ai-chip';
import { NotificationsBell } from '@/components/notifications-bell';

const NAV = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/profile', labelKey: 'profiles', icon: UserRound },
  { href: '/meal-plans', labelKey: 'mealPlans', icon: CalendarRange },
  { href: '/recipes', labelKey: 'recipes', icon: Soup },
  { href: '/shopping-lists', labelKey: 'shoppingLists', icon: ShoppingBasket },
  { href: '/inventory', labelKey: 'inventory', icon: Package },
  { href: '/settings', labelKey: 'settings', icon: Settings },
] as const;

/** From this width on the navigation stands beside the page: the `md` breakpoint of the styles. */
const WIDE = '(min-width: 48rem)';

/**
 * The navigation of a signed-in account. On a wide screen it stands beside
 * the page. On a narrow one there is no room for that: a bar lies over the
 * page, and its menu button opens the same navigation as a drawer.
 */
export function Sidebar() {
  const pathname = usePathname();
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const [drawer, setDrawer] = useState(false);

  // The drawer belongs to the narrow layout. A screen that grows past it (a
  // tablet turned on its side) has the navigation beside the page again, and
  // an open drawer would keep that page shut behind it.
  useEffect(() => {
    if (!drawer) return;
    const wide = window.matchMedia(WIDE);
    const close = (): void => {
      if (wide.matches) setDrawer(false);
    };
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, [drawer]);

  /** The links, and the way out. `onGo` is told when one of them is followed. */
  const navigation = (onGo?: () => void) => (
    <>
      <div className="mt-3 flex px-2">
        <AiChip />
      </div>
      <nav className="mt-3 flex flex-1 flex-col gap-1" aria-label={tNav('menu')}>
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onGo}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <item.icon size={18} className={active ? 'text-primary' : undefined} aria-hidden />
              {tNav(item.labelKey)}
            </Link>
          );
        })}
      </nav>
      <Button variant="ghost" size="sm" className="justify-start" onClick={() => void session.signOut()}>
        <LogOut size={18} aria-hidden /> {tNav('signOut')}
      </Button>
    </>
  );

  return (
    <>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card p-4 md:flex">
        <div className="flex items-center justify-between px-2">
          <span className="text-lg font-semibold tracking-tight">{tCommon('appName')}</span>
          <div className="flex items-center gap-1">
            <NotificationsBell />
            <ThemeToggle />
          </div>
        </div>
        {navigation()}
      </aside>

      <header className="flex items-center justify-between gap-2 border-b border-border bg-card px-2 py-1.5 md:hidden">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label={tNav('menu')} aria-haspopup="dialog" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <Menu size={20} aria-hidden />
          </Button>
          <span className="text-base font-semibold tracking-tight">{tCommon('appName')}</span>
        </div>
        <div className="flex items-center gap-1">
          <NotificationsBell align="end" />
          <ThemeToggle />
        </div>
      </header>
      <Dialog
        open={drawer}
        onClose={() => setDrawer(false)}
        label={tNav('menu')}
        className="drawer m-0 h-dvh max-h-dvh w-72 max-w-[85vw] rounded-none border-y-0 border-l-0 bg-card"
      >
        <div className="flex h-full flex-col p-4">
          <div className="flex items-center justify-between px-2">
            <span className="text-lg font-semibold tracking-tight">{tCommon('appName')}</span>
            <Button variant="ghost" size="sm" aria-label={tCommon('close')} onClick={() => setDrawer(false)}>
              <X size={18} aria-hidden />
            </Button>
          </div>
          {navigation(() => setDrawer(false))}
        </div>
      </Dialog>
    </>
  );
}
