/**
 * Reading a submitted form without trusting its shape.
 *
 * `FormData.get()` returns `string | File | null`. Converting that with `String()` turns a
 * file — or a field an attacker swapped for one — into the literal text "[object File]",
 * which then passes a length check as a perfectly good name. These return text or nothing.
 *
 * Safe on both server and client: no server-only imports.
 */
export function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

/** Every text value submitted under one name, such as a group of checkboxes. */
export function formTexts(data: FormData, name: string): string[] {
  return data.getAll(name).filter((value): value is string => typeof value === 'string');
}
