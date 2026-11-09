import type { AgentToolRun } from './agent-tools.js';
import type { Commands, HostCommandExecutor } from './commands.js';
import { Fault } from './control.js';
import type { Folders } from './folders.js';

const commandTool = {
  name: 'local_shell',
  description:
    'Run a Bash command on this computer inside a folder the Human connected to this Bot. Every command requires one-time approval. The sandbox limits file access to the connected folder and standard system tools, denies network access, and does not allow sudo. Use this when a local script or installed tool must process files in the connected folder; never run a host shell outside that folder.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'Exact connected folder ID from local_folders.' },
      cwd: {
        type: 'string',
        description: 'Optional working directory relative to the connected folder.',
      },
      command: { type: 'string', description: 'Bash command to run after Human approval.' },
    },
    required: ['folder', 'command'],
    additionalProperties: false,
  },
} as const;

export class LocalCommandTools {
  readonly surface = 'host-command';
  readonly list = [commandTool];
  readonly fields: Record<string, string[]> = {
    local_shell: ['folder', 'cwd', 'command'],
  };

  constructor(
    private readonly folders: Folders,
    private readonly commands: Commands,
    private readonly execute: HostCommandExecutor,
  ) {}

  async invoke(run: AgentToolRun, name: string, args: Record<string, unknown>, wireId?: string) {
    if (
      name !== 'local_shell' ||
      Object.keys(args).some((key) => !this.fields.local_shell.includes(key)) ||
      typeof args.command !== 'string' ||
      !args.command.trim() ||
      args.command.length > 12000 ||
      args.command.includes('\0')
    )
      throw new Fault('COMMAND_INVALID_REQUEST', 400);
    const directory = await this.folders.commandDirectory(run.bot, args.folder, args.cwd);
    return this.commands.invoke(
      {
        id: run.id,
        bot: run.bot,
        sessionId: run.sessionId,
        conversationId: run.conversationId,
        workdir: directory.cwd,
        root: directory.root,
        abort: run.abort,
        task: run.task,
        waitingForComputer: run.waitingForComputer,
        onComputerWait: run.onComputerWait,
      },
      name,
      args,
      wireId,
      async () => {
        const current = await this.folders.commandDirectory(run.bot, args.folder, args.cwd);
        if (current.root !== directory.root || current.cwd !== directory.cwd)
          throw new Fault('LOCAL_FOLDER_CHANGED');
        return this.execute(
          { command: args.command as string, cwd: directory.cwd, root: directory.root },
          run.abort.signal,
        );
      },
    );
  }
}
