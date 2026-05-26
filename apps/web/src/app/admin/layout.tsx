import type { ReactNode } from 'react';

/** Plain shell for the F16 admin panel — no app sidebar, no user identity. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Diet App · Admin</h1>
        <p className="text-xs text-muted-foreground">
          Instance-only stats — no user data is shown.
        </p>
      </header>
      {children}
    </div>
  );
}
