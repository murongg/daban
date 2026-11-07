export const processToolList = [
  {
    name: 'process_start',
    description:
      'Start a persistent Bash command in the Linux guest, with the actual task directory as cwd. Use relative output paths or the actual task directory from the request; /workspace and /shared are file-tool aliases and are not mounted here. Full guest files, network and passwordless sudo are available. Returns a process id; poll it rather than starting the command again. When using noclobber, create and write a new file in one step; do not precreate it before >, or bypass an existing-file conflict.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', maxLength: 64000 } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_poll',
    description:
      'Read the bounded output and actual state of an existing guest process. Unknown never means it is safe to rerun.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_input',
    description:
      'Write input once to an existing guest process. Set eof to close its input after writing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        data: { type: 'string', maxLength: 65536 },
        eof: { type: 'boolean' },
      },
      required: ['id', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_cancel',
    description:
      'Stop an existing guest process and its process group, then read the cancellation receipt.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
