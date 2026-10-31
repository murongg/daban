import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { syntheticOffice, syntheticPdf, syntheticScan } from './documents.fixture.js';
import { Documents } from './documents.js';

const native = process.platform === 'linux';
test('Linux sandbox extracts all supported formats including hidden sheets, cached formula values and slide notes', {
  skip: !native,
}, async () => {
  const parser = new Documents();
  try {
    for (const format of ['pdf', 'docx', 'xlsx', 'pptx'] as const) {
      const data = format === 'pdf' ? syntheticPdf('MOCK-PDF-47') : syntheticOffice(format);
      const text = await parser.extract({
        name: `synthetic.${format}`,
        data: data.toString('base64'),
      });
      assert.match(text, new RegExp(`MOCK-${format.toUpperCase()}-`));
      if (format === 'xlsx') {
        assert.match(text, /MOCK-XLSX-HIDDEN-53/);
        assert.match(text, /100/);
      }
      if (format === 'pptx') assert.match(text, /MOCK-PPTX-NOTES-53/);
      if (format === 'docx') assert.match(text, /合成中文/);
    }
    await assert.rejects(
      parser.extract({ name: 'empty.pdf', data: syntheticPdf('').toString('base64') }),
      { code: 'DOCUMENT_EMPTY' },
    );
    await assert.rejects(
      parser.extract({ name: 'scan.pdf', data: syntheticScan().toString('base64') }),
      { code: 'DOCUMENT_EMPTY' },
    );
    await assert.rejects(
      parser.extract({
        name: 'encrypted.pdf',
        data: syntheticPdf('ENCRYPTED', true).toString('base64'),
      }),
      { code: 'DOCUMENT_ENCRYPTED' },
    );
    await assert.rejects(
      parser.extract({ name: 'corrupt.pdf', data: Buffer.from('not a PDF').toString('base64') }),
      { code: 'DOCUMENT_UNREADABLE' },
    );
    await assert.rejects(
      parser.extract({ name: 'spoof.pdf', data: syntheticOffice('docx').toString('base64') }),
      { code: 'DOCUMENT_UNREADABLE' },
    );
    const expanded = unzipSync(syntheticOffice('xlsx'));
    expanded['xl/worksheets/sheet1.xml'] = strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row>${'<c t="inlineStr"><is><t>x</t></is></c>'.repeat(70000)}</row></sheetData></worksheet>`,
    );
    await assert.rejects(
      parser.extract({
        name: 'partial.xlsx',
        data: Buffer.from(zipSync(expanded)).toString('base64'),
      }),
      { code: 'DOCUMENT_INCOMPLETE' },
    );
    const bomb = zipSync({
      ...unzipSync(syntheticOffice('docx')),
      'word/document.xml': strToU8('x'.repeat(17 * 1024 * 1024)),
    });
    await assert.rejects(
      parser.extract({ name: 'bomb.docx', data: Buffer.from(bomb).toString('base64') }),
      { code: 'DOCUMENT_LIMIT' },
    );
    const large = unzipSync(syntheticOffice('docx'));
    large['word/document.xml'] = strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
        'x'.repeat(210000) +
        '</w:t></w:r></w:p></w:body></w:document>',
    );
    await assert.rejects(
      parser.extract({ name: 'large.docx', data: Buffer.from(zipSync(large)).toString('base64') }),
      { code: 'DOCUMENT_LIMIT' },
    );
    const abort = new AbortController();
    const children = `/proc/self/task/${process.pid}/children`;
    const before = new Set((await readFile(children, 'utf8')).trim().split(/\s+/));
    const active = parser.extract(
      { name: 'cancel.pdf', data: syntheticPdf('CANCEL').toString('base64') },
      abort.signal,
    );
    active.catch(() => {});
    await assert.rejects(
      parser.extract({ name: 'busy.pdf', data: syntheticPdf('BUSY').toString('base64') }),
      { code: 'DOCUMENT_BUSY' },
    );
    let worker: string | undefined;
    const deadline = Date.now() + 3000;
    while (!worker && Date.now() < deadline) {
      worker = (await readFile(children, 'utf8'))
        .trim()
        .split(/\s+/)
        .find((id) => /^\d+$/.test(id) && !before.has(id));
      if (!worker) await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 1));
    }
    assert.ok(worker, 'observe a running sandbox before cancellation');
    abort.abort();
    await assert.rejects(active);
    await assert.rejects(readFile(`/proc/${worker}/status`, 'utf8'), { code: 'ENOENT' });
    assert.match(
      await parser.extract({
        name: 'after-cancel.pdf',
        data: syntheticPdf('RECOVERED').toString('base64'),
      }),
      /RECOVERED/,
    );
  } finally {
    await parser.close();
  }
});
