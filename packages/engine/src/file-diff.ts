import {
  compareReviewPaths,
  type ReviewCapture,
  type ReviewChange,
  type ReviewDiff,
  type ReviewFile,
  reviewFileKey,
} from '@daban/protocol';

export function classify(before: ReviewFile, after: ReviewFile): ReviewChange['kind'] {
  if (before.state === 'unknown' || after.state === 'unknown') return 'unknown';
  if (before.state === 'absent') return after.state === 'present' ? 'created' : 'unchanged';
  if (after.state === 'absent') return 'deleted';
  return before.sha256 === after.sha256 ? 'unchanged' : 'modified';
}
export function compareFiles(before: ReviewCapture[], after: ReviewCapture[]): ReviewChange[] {
  const left = new Map(
    before.flatMap((capture) => capture.files.map((file) => [reviewFileKey(file), file] as const)),
  );
  const right = new Map(
    after.flatMap((capture) => capture.files.map((file) => [reviewFileKey(file), file] as const)),
  );
  const missing = (file: ReviewFile, captures: ReviewCapture[]): ReviewFile => {
    const snapshot = captures.find((capture) => capture.snapshot.area === file.area)?.snapshot;
    // An omitted path in a partial walk is missing evidence, never proof of deletion.
    return snapshot?.capture === 'complete'
      ? { area: file.area, path: file.path, state: 'absent' }
      : {
          area: file.area,
          path: file.path,
          state: 'unknown',
          reason: snapshot?.reasons[0] ?? 'baseline-missing',
        };
  };
  return [...new Set([...left.keys(), ...right.keys()])].sort(compareReviewPaths).map((key) => {
    const a = left.get(key) ?? missing(right.get(key)!, before);
    const b = right.get(key) ?? missing(left.get(key)!, after);
    return { before: a, after: b, kind: classify(a, b) };
  });
}
export function diffText(
  before: string,
  after: string,
):
  | Pick<Extract<ReviewDiff, { state: 'text' }>, 'state' | 'lines'>
  | { state: 'unavailable'; reason: 'diff-limit' } {
  const unavailable = { state: 'unavailable', reason: 'diff-limit' } as const;
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const b = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (a.length > 2000 || b.length > 2000 || (a.length + 1) * (b.length + 1) > 2_000_000)
    return unavailable;
  const width = b.length + 1;
  const lengths = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
  const lines: Extract<ReviewDiff, { state: 'text' }>['lines'] = [];
  let i = 0,
    j = 0,
    bytes = 2;
  while (i < a.length || j < b.length) {
    let line: (typeof lines)[number];
    if (i < a.length && j < b.length && a[i] === b[j]) {
      line = { kind: 'context', text: a[i++] };
      j++;
    } else if (
      i < a.length &&
      (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    )
      line = { kind: 'remove', text: a[i++] };
    else line = { kind: 'add', text: b[j++] };
    bytes += Buffer.byteLength(JSON.stringify(line)) + (lines.length ? 1 : 0);
    if (lines.length === 2000 || bytes > 200 * 1024) return unavailable;
    lines.push(line);
  }
  return { state: 'text', lines };
}
