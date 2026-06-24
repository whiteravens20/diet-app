'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  CalendarRange,
  LayoutDashboard,
  LogOut,
  Package,
  Settings,
  ShoppingBasket,
  Soup,
  UserRound,
} from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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

/** Persistent app navigation. */
export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');

  async function logout() {
    if (tokenStore.refresh) {
      await api.post('/auth/logout', { refreshToken: tokenStore.refresh }).catch(() => undefined);
    }
    tokenStore.clear();
    router.push('/login');
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card p-4">
      <div className="flex items-center justify-between px-2">
        <span className="text-lg font-semibold tracking-tight">{tCommon('appName')}</span>
        <div className="flex items-center gap-1">
          <NotificationsBell />
          <ThemeToggle />
        </div>
      </div>
      <div className="mt-3 flex px-2">
        <AiChip />
      </div>
      <nav className="mt-3 flex flex-1 flex-col gap-1">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <item.icon size={18} />
              {tNav(item.labelKey)}
            </Link>
          );
        })}
      </nav>
      <Button variant="ghost" size="sm" className="justify-start" onClick={logout}>
        <LogOut size={18} /> {tNav('signOut')}
      </Button>
    </aside>
  );
}
