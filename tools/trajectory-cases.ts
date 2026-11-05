import { createHash } from 'node:crypto';
import type { TrajectoryCase } from '@daban/engine/agent';

const files = [
  { path: 'input.txt', utf8: 'SYNTHETIC INPUT\n' },
  { path: 'report.txt', utf8: 'SYNTHETIC REPORT\n' },
];

const fileCase: TrajectoryCase = {
  schema: 1,
  id: 'simulated-file-sequence',
  revision: 1,
  input: {
    prompt: 'SYNTHETIC: read the synthetic input and write the synthetic report.',
    events: [
      {
        kind: 'call',
        callId: 'mock-read',
        tool: 'read_file',
        args: { path: `\${workspace}/input.txt` },
      },
      { kind: 'result', callId: 'mock-read', body: { text: 'SYNTHETIC INPUT\n' }, isError: false },
      {
        kind: 'call',
        callId: 'mock-write',
        tool: 'write_file',
        args: { path: `\${workspace}/report.txt`, content: 'SYNTHETIC REPORT\n' },
      },
      { kind: 'result', callId: 'mock-write', body: { ok: true }, isError: false },
      { kind: 'barrier', action: 'complete' },
    ],
    files,
  },
  steps: [
    {
      slot: 'read',
      tool: 'read_file',
      args: { path: `\${workspace}/input.txt` },
      result: 'success',
    },
    {
      slot: 'write',
      tool: 'write_file',
      args: { path: `\${workspace}/report.txt`, content: 'SYNTHETIC REPORT\n' },
      result: 'success',
    },
  ],
  terminal: 'completed',
  budget: { maxCalls: 2, maxModelRequests: 1 },
  artifacts: files.map((file) => ({
    path: file.path,
    size: Buffer.byteLength(file.utf8),
    sha256: createHash('sha256').update(file.utf8).digest('hex'),
  })),
  rules: [
    { pointer: '/read/path', kind: 'workspace', alias: 'workspace' },
    { pointer: '/write/path', kind: 'workspace', alias: 'workspace' },
  ],
  sensitive: [],
};

function errorCase(
  id: string,
  slot: string,
  code: string,
  action: 'complete' | 'stop',
  stopAfter: boolean,
): TrajectoryCase {
  return {
    schema: 1,
    id,
    revision: 1,
    input: {
      prompt: 'SYNTHETIC: observe this recorded outcome without another call.',
      events: [
        {
          kind: 'call',
          callId: `mock-${slot}`,
          tool: 'shell',
          args: { command: 'SYNTHETIC COMMAND' },
        },
        { kind: 'result', callId: `mock-${slot}`, body: { error: code }, isError: true },
        { kind: 'barrier', action },
      ],
      files: [],
    },
    steps: [{ slot, tool: 'shell', args: { command: 'SYNTHETIC COMMAND' }, result: 'error', code }],
    terminal: action === 'stop' ? 'stopped' : 'completed',
    budget: { maxCalls: 1, maxModelRequests: 1 },
    artifacts: [],
    rules: [],
    sensitive: [],
    ...(stopAfter ? { stopAfter: slot } : {}),
  };
}

export const smokeCases: readonly TrajectoryCase[] = [
  fileCase,
  errorCase('simulated-refusal-sequence', 'refusal', 'COMMAND_APPROVAL_REJECTED', 'complete', true),
  errorCase('simulated-cancel-sequence', 'cancel', 'COMMAND_CANCELLED', 'stop', true),
];

export const unknownCase = errorCase(
  'unknown-no-replay',
  'unknown',
  'COMMAND_OUTCOME_UNKNOWN',
  'complete',
  false,
);
export const trajectoryCases: readonly TrajectoryCase[] = [...smokeCases, unknownCase];
