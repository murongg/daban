import { pathToFileURL } from 'node:url';
import { runtimeRequire } from './dsh.js';

export const name = 'daban-office';
export const inject = ['skills'];
interface Candidate extends Record<string, unknown> {
  name: string;
}
interface Lookup {
  signal?: AbortSignal;
}
interface Provider {
  name: string;
  list(options?: Lookup): Promise<Candidate[]>;
  get(candidate: Candidate, options: Lookup): Promise<Candidate & { content: string }>;
}
interface Context {
  skills: { registerProvider: (factory: (control: unknown) => Provider) => unknown };
}
const resourceBase = {
  kind: 'opaque',
  description:
    'Bundled Office instructions adapted to the Linux execution workspace. No host resource directory is exposed.',
};
const deployment = `## Daban execution environment

These deployment instructions take precedence over upstream runtime and path examples. Work only through the offered Linux shell/process tools in the actual task workspace. Use write_file for source scripts, shell or process_start to run them, and read_image to inspect saved raster previews when that tool is offered. Native host filesystem, host Python/Node and host LibreOffice Kit are unavailable. No load_workspace_dependencies or present tool is required: verify final files with list_files and report their actual workspace paths for the existing file delivery flow.

The configured Linux interpreter is /usr/bin/python3. First inspect required imports with that interpreter. Missing dependencies must go through software_install with the current task's purpose and exact official Debian packages: python3-docx and python3-openpyxl; PPTX can use an already configured python-pptx, or the official python3-uno plus libreoffice-impress packages; document conversion uses libreoffice-writer, libreoffice-calc, libreoffice-impress and poppler-utils. Install only packages required by this task. This skill grants no installation, file, network or desktop permission; respect the exact existing approval and cancellation flow. Never use pip, npx, an unapproved download or a host path to bypass a missing dependency. If software_install is unavailable or declined, report the missing capability.

For PPTX, inspect import pptx before using the upstream authoring examples. If unavailable, use LibreOffice UNO through /usr/bin/python3 after approved python3-uno/libreoffice-impress installation; do not request a guessed Debian python-pptx package. Start headless LibreOffice with a unique private task-local profile and a random named pipe (--accept=pipe,name=<unique-name>;urp;StarOffice.ComponentContext), managed by process_start. Resolve that pipe with uno.UnoUrlResolver, load private:factory/simpress, populate draw pages and text shapes, then storeAsURL with FilterName "Impress MS PowerPoint 2007 XML". Inspect the actual exported PPTX ZIP and relevant text/slide counts, and reopen it through LibreOffice before claiming success. Close the document and stop that exact owned listener after consumers finish. Do not open a public TCP listener or use another Bot's profile.

Keep authored scripts, source copies, outputs and temporary profiles inside the owned task directory. Protect existing inputs; save a new file unless an in-place edit was requested. Never claim visual verification without inspecting actual images. A text-only model may complete content/data checks and deliver requested image exports, but must report visual inspection as unavailable.
`;
const operations: Record<string, string> = {
  'office-export-pdf': `# Export PDF
Use the installed Linux LibreOffice CLI, not host LibreOffice Kit. Create a uniquely named private temporary directory inside this task with separate input, output and profile directories. Copy the source into input; keep its original unchanged. Run libreoffice in headless mode with a unique -env:UserInstallation=file:///... profile and --convert-to pdf --outdir <output> <input-file>. Quote every path. Use process_start for a long conversion and poll that exact process. Verify exit status, a nonempty output and the %PDF- signature before reporting success. Copy the verified PDF to a new final task filename. Remove only this operation's temporary directory after its consumers finish. Deliver only requested outputs.`,
  'office-recalculate': `# Recalculate workbook formulas
Read the source with openpyxl using data_only=False and record the relevant formulas. Use private task-local input/output/profile directories, copy the workbook into input, then run Linux libreoffice headlessly with its unique -env:UserInstallation=file:///... profile, --convert-to xlsx and the separate --outdir output directory. Never convert onto the source itself. Reopen the output with openpyxl in both formula and data_only modes; verify requested formulas survived and their cached results match the task. Report unsupported formulas or fidelity changes rather than claiming success. Preserve macros and unsupported features by declining an unsafe round trip. Deliver a new verified workbook unless replacement was explicitly requested.`,
  'office-render': `# Render and inspect Office files
Use a private task-local directory and a unique LibreOffice profile; first convert a source copy to PDF using office-export-pdf. For a PDF input reuse its bytes. Use pdftoppm -png with quoted input/output paths, bounded page ranges and a reasonable resolution to generate the requested pages. For an affected spreadsheet range, set print_area only on a temporary workbook copy, never the original. Inspect relevant pages with read_image only when offered; do not infer layout from extracted text. Check clipping, font availability, table widths, alignment, charts and number formats. For populated content a blank/transparent preview is a rendering failure: stop visual checks, preserve the source, and report content/data checks separately from incomplete visual inspection. Keep requested image exports; remove inspection-only images after reading them. LibreOffice rendering does not guarantee native Office fidelity or animation/media playback.`,
};
function publicCandidate(candidate: Candidate): Candidate {
  const { path: _path, resourceBase: _base, ...fields } = candidate;
  return { ...fields, name: candidate.name, resourceBase };
}
export function adaptOffice(source: Provider): Provider {
  return {
    ...source,
    async list(options) {
      return (await source.list(options)).map(publicCandidate);
    },
    async get(candidate, options) {
      // Operation paths belong to the guest. Never resolve or advertise the SDK host's interpreter/sidecar.
      const skill = operations[candidate.name]
        ? { ...candidate, content: operations[candidate.name] }
        : await source.get(candidate, options);
      const { locator: _locator, rank: _rank, ...definition } = publicCandidate(skill);
      return { ...definition, name: skill.name, content: `${deployment}\n\n${skill.content}` };
    },
  };
}
export async function apply(ctx: Context, config: { sdkFile: string }) {
  const native = await import(
    pathToFileURL(runtimeRequire(config.sdkFile).resolve('@deepseek-ai/dsh-skill-office')).href
  );
  native.apply(
    {
      skills: {
        registerProvider: (create: (control: unknown) => Provider) =>
          ctx.skills.registerProvider((control) => adaptOffice(create(control))),
      },
    },
    { cli: false },
  );
}
