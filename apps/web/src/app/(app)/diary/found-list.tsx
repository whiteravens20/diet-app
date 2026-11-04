// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** What a search of the window found, as buttons to pick. */
export function FoundList({
  found,
}: {
  found: { id: string; name: string; about: string; pick: () => void }[];
}) {
  return (
    <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
      {found.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            onClick={item.pick}
          >
            <span className="max-w-full break-words text-sm font-medium">{item.name}</span>
            <span className="text-xs text-muted-foreground">{item.about}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
