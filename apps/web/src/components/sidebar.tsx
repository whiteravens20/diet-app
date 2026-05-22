'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  CalendarRange,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Settings,
  Soup,
  UserRound,
} from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/profile', label: 'Profile', icon: UserRound },
  { href: '/meal-plans', label: 'Meal plans', icon: CalendarRange },
  { href: '/recipes', label: 'Recipes', icon: Soup },
  { href: '/shopping-lists', label: 'Shopping', icon: ListChecks },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/** Persistent app navigation. */
export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

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
        <span className="text-lg font-semibold tracking-tight">Diet App</span>
        <ThemeToggle />
      </div>
      <nav className="mt-6 flex flex-1 flex-col gap-1">
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
              {item.label}
            </Link>
          );
        })}
      </nav>
      <Button variant="ghost" size="sm" className="justify-start" onClick={logout}>
        <LogOut size={18} /> Sign out
      </Button>
    </aside>
  );
}
