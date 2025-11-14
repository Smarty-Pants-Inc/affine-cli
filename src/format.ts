/*
 * Output formatting helpers for CLI-014
 */

export type TableValue = string | number | null | undefined;

export function toJsonList<T>(items: T[], pageInfo?: unknown) {
  const payload: any = { items };
  if (pageInfo && Object.keys(pageInfo as any).length > 0) payload.pageInfo = pageInfo;
  return payload;
}

/**
 * Render rows as fixed-width table lines with computed column widths.
 * - columns define order; values are coerced to string; null/undefined -> ''
 * - all but the last column are padded to width with spaces; last column not padded
 */
export function toTable(
  rows: Array<Record<string, TableValue>>,
  columns: string[],
): string[] {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => str(r[c]).length)));
  const lines: string[] = [];
  for (const r of rows) {
    const parts: string[] = [];
    columns.forEach((c, idx) => {
      const s = str(r[c]);
      if (idx === columns.length - 1) parts.push(s);
      else parts.push(padEnd(s, widths[idx]));
    });
    lines.push(parts.join(' '));
  }
  return lines;
}

function str(v: TableValue): string {
  if (v === null || typeof v === 'undefined') return '';
  return String(v);
}

function padEnd(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}

export default { toJsonList, toTable };
