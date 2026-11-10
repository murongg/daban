import { Fault } from './control.js';

export interface CsvCheck {
  rows: number;
  sum?: { column: string; total: string };
}

function cents(value: string) {
  if (!/^-?\d{1,18}(?:\.\d{1,2})?$/.test(value)) return;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return value.startsWith('-') ? -amount : amount;
}

function decimal(amount: bigint) {
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function csvCheck(rows: unknown, sum: unknown): CsvCheck {
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0)
    throw new Fault('INVALID_TOOL_ARGS', 400);
  if (sum === undefined) return { rows };
  if (
    !sum ||
    typeof sum !== 'object' ||
    !('column' in sum) ||
    typeof sum.column !== 'string' ||
    !sum.column ||
    sum.column.length > 512 ||
    !('total' in sum) ||
    typeof sum.total !== 'string' ||
    Object.keys(sum).length !== 2
  )
    throw new Fault('INVALID_TOOL_ARGS', 400);
  const total = cents(sum.total);
  if (total === undefined) throw new Fault('INVALID_TOOL_ARGS', 400);
  return { rows, sum: { column: sum.column, total: decimal(total) } };
}

export function checkCsv(content: string, expected: CsvCheck) {
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r?\n|$)/y;
  let cursor = 0;
  function record() {
    const values: string[] = [];
    for (;;) {
      field.lastIndex = cursor;
      const match = field.exec(content);
      if (!match) throw new Fault('INVALID_CSV');
      cursor = field.lastIndex;
      if (!match[3] && cursor !== content.length) throw new Fault('INVALID_CSV');
      values.push(match[1]?.replaceAll('""', '"') ?? match[2]);
      if (match[3] !== ',') return values;
    }
  }
  if (!content) throw new Fault('INVALID_CSV');
  const header = record();
  if (header.some((name) => !name) || new Set(header).size !== header.length)
    throw new Fault('INVALID_CSV_HEADER');
  const column = expected.sum ? header.indexOf(expected.sum.column) : -1;
  if (expected.sum && column < 0) throw new Fault('CSV_COLUMN_MISSING');
  let rows = 0;
  let total = 0n;
  while (cursor < content.length) {
    const values = record();
    if (values.length !== header.length) throw new Fault('INVALID_CSV');
    rows++;
    if (column >= 0) {
      const amount = cents(values[column]);
      if (amount === undefined) throw new Fault('CSV_INVALID_AMOUNT');
      total += amount;
    }
  }
  const sum = expected.sum ? decimal(total) : undefined;
  const passed = rows === expected.rows && sum === expected.sum?.total;
  return {
    passed,
    actual: { rows, ...(sum !== undefined ? { total: sum } : {}) },
    ...(!passed ? { code: 'CSV_CHECK_FAILED' } : {}),
  };
}
