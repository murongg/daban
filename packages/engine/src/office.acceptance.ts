import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { WorkspaceFiles } from './workspace.js';

assert.equal(process.platform, 'linux');
const root = await realpath(await mkdtemp('/tmp/daban-office-acceptance-'));
const run = (program: string, args: string[]) =>
  execFileSync(program, args, { cwd: root, timeout: 60000, stdio: 'inherit' });
// Synthetic end-user Python programs exercise the Office workflows; application and test orchestration remain TypeScript.
run('/usr/bin/python3', [
  '-c',
  `
import os,sys
from docx import Document
from openpyxl import Workbook
root=sys.argv[1]
doc=Document()
doc.add_heading('SYNTHETIC OFFICE CHECK',0)
doc.add_paragraph('Synthetic content only. No user or production data.')
doc.save(os.path.join(root,'source.docx'))
wb=Workbook(); ws=wb.active; ws.title='Synthetic'
ws['A1']='SYNTHETIC VALUES'; ws['A2']=19; ws['A3']=23; ws['A4']='=SUM(A2:A3)'
wb.save(os.path.join(root,'source.xlsx'))
`,
  root,
]);
const pipe = `daban-office-${randomUUID()}`;
const listener = spawn(
  '/usr/bin/libreoffice',
  [
    '--headless',
    '--nologo',
    '--nodefault',
    '--norestore',
    `-env:UserInstallation=${pathToFileURL(path.join(root, 'uno-profile')).href}`,
    `--accept=pipe,name=${pipe};urp;StarOffice.ComponentContext`,
  ],
  { detached: true, stdio: 'ignore' },
);
try {
  run('/usr/bin/python3', [
    '-c',
    `
import os,sys,time,uno
from com.sun.star.beans import PropertyValue
root,pipe=sys.argv[1:]
local=uno.getComponentContext()
resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local)
remote=None
for attempt in range(100):
 try:
  remote=resolver.resolve('uno:pipe,name='+pipe+';urp;StarOffice.ComponentContext'); break
 except Exception: time.sleep(.1)
assert remote is not None
desktop=remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',remote)
hidden=PropertyValue(); hidden.Name='Hidden'; hidden.Value=True
deck=desktop.loadComponentFromURL('private:factory/simpress','_blank',0,(hidden,))
pages=deck.getDrawPages()
page=pages.getByIndex(0) if pages.getCount() else pages.insertNewByIndex(0)
shape=deck.createInstance('com.sun.star.drawing.TextShape'); page.add(shape)
point=uno.createUnoStruct('com.sun.star.awt.Point'); point.X=1500; point.Y=1500; shape.Position=point
size=uno.createUnoStruct('com.sun.star.awt.Size'); size.Width=22000; size.Height=5000; shape.Size=size
shape.String='SYNTHETIC PRESENTATION CHECK'; shape.CharHeight=24
filter=PropertyValue(); filter.Name='FilterName'; filter.Value='Impress MS PowerPoint 2007 XML'
deck.storeAsURL(uno.systemPathToFileUrl(os.path.join(root,'source.pptx')),(filter,))
deck.close(True); desktop.terminate()
`,
    root,
    pipe,
  ]);
} finally {
  if (listener.pid) {
    try {
      process.kill(-listener.pid, 'SIGTERM');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
        console.error(error);
        process.exitCode = 1;
      }
    }
  }
}
const recalc = path.join(root, 'recalculated');
await mkdir(recalc);
run('/usr/bin/libreoffice', [
  '--headless',
  `-env:UserInstallation=${pathToFileURL(path.join(root, 'recalc-profile')).href}`,
  '--convert-to',
  'xlsx',
  '--outdir',
  recalc,
  path.join(root, 'source.xlsx'),
]);
run('/usr/bin/python3', [
  '-c',
  `
import os,sys,zipfile
from docx import Document
from openpyxl import load_workbook
root=sys.argv[1]
assert Document(os.path.join(root,'source.docx')).paragraphs[0].text=='SYNTHETIC OFFICE CHECK'
source=load_workbook(os.path.join(root,'source.xlsx'),data_only=False)
assert source.active['A4'].value=='=SUM(A2:A3)'
formula=load_workbook(os.path.join(root,'recalculated/source.xlsx'),data_only=False)
cached=load_workbook(os.path.join(root,'recalculated/source.xlsx'),data_only=True)
assert formula.active['A4'].value=='=SUM(A2:A3)'
assert cached.active['A4'].value==42
with zipfile.ZipFile(os.path.join(root,'source.pptx')) as deck:
 assert b'SYNTHETIC PRESENTATION CHECK' in deck.read('ppt/slides/slide1.xml')
`,
  root,
]);
const tools = new AgentTools(undefined, new WorkspaceFiles(root));
const task: AgentToolRun = {
  id: 'mock-office-linux',
  bot: 'mock-office',
  vision: true,
  abort: new AbortController(),
  workdir: root,
  canonicalRoot: root,
  toolCount: 0,
  limit: 20,
  trace: [],
  seen: {},
};
const previews: { format: string; path: string; sha256: string }[] = [];
for (const format of ['docx', 'xlsx', 'pptx']) {
  const pdfRoot = path.join(root, `pdf-${format}`);
  await mkdir(pdfRoot);
  const input =
    format === 'xlsx' ? path.join(recalc, 'source.xlsx') : path.join(root, `source.${format}`);
  run('/usr/bin/libreoffice', [
    '--headless',
    `-env:UserInstallation=${pathToFileURL(path.join(root, `profile-${format}`)).href}`,
    '--convert-to',
    'pdf',
    '--outdir',
    pdfRoot,
    input,
  ]);
  const pdf = path.join(pdfRoot, 'source.pdf');
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-');
  const prefix = path.join(root, `preview-${format}`);
  run('/usr/bin/pdftoppm', ['-f', '1', '-singlefile', '-r', '90', '-png', pdf, prefix]);
  const file = `${prefix}.png`,
    bytes = await readFile(file);
  const result = await tools.invoke(task, 'read_image', { path: file });
  assert(!result.isError, JSON.stringify(result));
  const image = result.content[0];
  assert.equal(image.type, 'image');
  if (image.type !== 'image') throw new Error('IMAGE_RESULT_EXPECTED');
  assert.equal(image.mimeType, 'image/png');
  assert(Buffer.from(image.data, 'base64').equals(bytes));
  previews.push({ format, path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await symlink(previews[0].path, path.join(root, 'linked.png'));
assert.equal((await tools.invoke(task, 'read_image', { path: 'linked.png' })).isError, true);
assert.equal(
  (await tools.invoke({ ...task, vision: false }, 'read_image', { path: previews[0].path }))
    .isError,
  true,
);
task.abort.abort();
assert.equal((await tools.invoke(task, 'read_image', { path: previews[0].path })).isError, true);
const report = {
  scope: 'Fresh isolated Linux VM; synthetic Office data; no model/provider or original workspace',
  root,
  node: process.version,
  formats: ['docx', 'xlsx', 'pptx'],
  formula: 42,
  sourceFormulaPreserved: true,
  pdfSignatures: 3,
  readImageByteChecks: 3,
  symlinkRefused: true,
  textModelRefused: true,
  cancelledReadRefused: true,
  previews,
};
await writeFile(
  process.argv[2] || path.join(root, 'verification.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
