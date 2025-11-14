/*
 * Error helpers for friendly UX (CLI-015)
 */

export function withHints(message: string, hints?: string[]): string {
  const list = (hints ?? []).filter(Boolean);
  if (list.length === 0) return message;
  const suffix = ['','Hints:'].concat(list.map((h) => ` - ${h}`)).join('\n');
  return `${message}\n${suffix}`;
}

export default { withHints };
