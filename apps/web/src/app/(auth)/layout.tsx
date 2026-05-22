import type { ReactNode } from 'react';

/** Centred shell for the auth screens. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-6">{children}</div>;
}
