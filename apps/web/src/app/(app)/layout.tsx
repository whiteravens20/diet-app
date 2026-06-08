import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';

/** Authenticated app shell: persistent sidebar + scrollable content. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1">
      <Sidebar />
      <main className="flex-1 overflow-y-auto px-8 py-10">{children}</main>
    </div>
  );
}
