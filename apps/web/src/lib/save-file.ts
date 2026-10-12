// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Hand the browser a file to keep, under a name. The file is made on the
 * page from what the page already holds: nothing is asked of a server for it.
 */
export function saveFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The same, for a text: `type` is what the file is, as a browser names kinds of files. */
export function saveText(text: string, name: string, type: string): void {
  saveFile(new Blob([text], { type: `${type};charset=utf-8` }), name);
}
