import { documentLimit, isKnowledgeContent } from '@daban/protocol';
import { type OfficeContentNode, OfficeParser, type OfficeParserConfig } from 'officeparser';

async function extract() {
  const format = process.argv[2];
  if (!['pdf', 'docx', 'xlsx', 'pptx'].includes(format)) throw new Error('invalid format');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > documentLimit) return { error: 'DOCUMENT_LIMIT' };
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  if (
    format === 'pdf'
      ? !data.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : !data.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))
  )
    return { error: 'DOCUMENT_UNREADABLE' };
  const config: OfficeParserConfig<'pdf'> = {
    fileType: format as 'pdf' | 'docx' | 'xlsx' | 'pptx',
    allowRemoteAssets: false,
    ocr: false,
    extractAttachments: false,
    includeRawContent: false,
    ignoreNotes: false,
    ignoreComments: false,
    ignoreHeadersAndFooters: false,
    abortSignal: AbortSignal.timeout(12000),
    decompressionLimits: {
      maxUncompressedBytes: 16 * 1024 * 1024,
      maxZipEntries: 2000,
      maxTableCells: 50000,
      maxXmlElements: 100000,
      maxRawContentLength: 1024 * 1024,
      maxRepeatedContent: 1024 * 1024,
    },
    pdfParserConfig: {
      separateProcess: false,
      maxTextItems: 50000,
      maxOperators: 100000,
      maxAnnotations: 2000,
      maxTimeMs: 10000,
    },
  };
  const ast = await OfficeParser.parseOffice(data, config);
  const hasText = (node: OfficeContentNode): boolean =>
    (node.type === 'text' && !!node.text?.trim()) ||
    [...(node.children || []), ...(node.notes || []), ...(node.comments || [])].some(hasText);
  const realPdfText = format === 'pdf' && ast.content.some(hasText);
  if (format === 'pdf' && !realPdfText) return { error: 'DOCUMENT_EMPTY' };
  const result = await ast.to('text', { includeImages: false });
  if (!result.value.trim()) return { error: 'DOCUMENT_EMPTY' };
  // Parser limits may return partial success; never commit it as a complete imported document.
  // The library's scan heuristic warns on short valid PDF text; actual text nodes distinguish it from image placeholders.
  if (
    [...ast.warnings, ...result.messages].some(
      (issue) => issue.type !== 'info' && !(realPdfText && issue.code === 'PDF_NO_TEXT_EXTRACTED'),
    )
  )
    return { error: 'DOCUMENT_INCOMPLETE' };
  if (!isKnowledgeContent(result.value)) return { error: 'DOCUMENT_LIMIT' };
  return { content: result.value };
}
try {
  process.stdout.write(JSON.stringify(await extract()));
} catch (error) {
  const code =
    error && typeof error === 'object' && 'officeIssue' in error
      ? String((error.officeIssue as { code?: unknown } | undefined)?.code || '')
      : '';
  process.stdout.write(
    JSON.stringify({
      error: /PASSWORD|ENCRYPT|DECRYPT/.test(code)
        ? 'DOCUMENT_ENCRYPTED'
        : /LIMIT_EXCEEDED|OUTPUT_TOO_LARGE|MAX_NESTING/.test(code)
          ? 'DOCUMENT_LIMIT'
          : 'DOCUMENT_UNREADABLE',
    }),
  );
}
