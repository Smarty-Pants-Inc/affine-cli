import { describe, it, expect } from 'vitest';

import { toJsonList, toTable } from '../src/format';

describe('format helpers', () => {
  it('toJsonList wraps items and optional pageInfo', () => {
    const items = [{ id: '1' }, { id: '2' }];
    const pageInfo = { hasNextPage: true, endCursor: 'cur2' };
    const payload = toJsonList(items, pageInfo);
    expect(payload.items).toEqual(items);
    expect(payload.pageInfo).toEqual(pageInfo);

    const payloadNoPageInfo = toJsonList(items);
    expect(payloadNoPageInfo.items).toEqual(items);
    expect('pageInfo' in payloadNoPageInfo).toBe(false);
  });

  it('toTable renders fixed-width columns with last column unpadded', () => {
    const rows = [
      { id: '1', title: 'Short' },
      { id: '22', title: 'A much longer title' },
    ];
    const lines = toTable(rows, ['id', 'title']);
    expect(lines).toHaveLength(2);
    const [l1, l2] = lines;

    // id column appears first and the final title column is not padded
    expect(l1.trimStart().startsWith('1')).toBe(true);
    expect(l2.trimStart().startsWith('22')).toBe(true);
    expect(l1.endsWith('Short')).toBe(true);
    expect(l2.endsWith('A much longer title')).toBe(true);
  });
});
