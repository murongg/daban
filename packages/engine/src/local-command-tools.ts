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

const workspaceShell = {
  name: 'workspace_shell',
  description:
    'Run Bash on this computer in the current task directory. Use write_file to create a script there, then use this tool to run it with an installed interpreter and check its output. Use relative paths. The sandbox permits only this task directory, temporary files, and standard system tools, without network or sudo. Use web_fetch separately for public URLs.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'Bash command to run in this task.' } },
    required: ['command'],
    additionalProperties: false,
  },
} as const;

export class LocalCommandTools {
  readonly surface = 'host-command';
  readonly list = [workspaceShell, commandTool];
  readonly fields: Record<string, string[]> = {
    local_shell: ['folder', 'cwd', 'command'],
    workspace_shell: ['command'],
  };

  constructor(
    private readonly folders: Folders,
    private readonly commands: Commands,
    private readonly execute: HostCommandExecutor,
  ) {}

  listFor(run?: AgentToolRun) {
    return this.unrestricted(run)
      ? [
          {
            ...workspaceShell,
            description:
              'Run Bash directly on this computer, starting in the current task directory. The user granted full host command access for this task. Commands have the current OS account’s file and network access. Use this for authorized host work and verify the result.',
          },
          commandTool,
        ]
      : this.list;
  }

  private unrestricted(run?: AgentToolRun) {
    return run?.task?.approvalMode === 'full' && run.task.hostCommandFullAccess === true;
  }

  async invoke(run: AgentToolRun, name: string, args: Record<string, unknown>, wireId?: string) {
    const { command, folder, cwd } = args;
    if (
      !Object.hasOwn(this.fields, name) ||
      Object.keys(args).some((key) => !this.fields[name].includes(key)) ||
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 12000 ||
      command.includes('\0')
    )
      throw new Fault('COMMAND_INVALID_REQUEST', 400);
    const taskDirectory = name === 'workspace_shell' ? run.localTaskDirectory : undefined;
    if (
      name === 'workspace_shell' &&
      (!taskDirectory || taskDirectory.canonical !== run.canonicalRoot)
    )
      throw new Fault('TASK_DIRECTORY_MOVED', 409);
    await taskDirectory?.verify();
    const directory = taskDirectory
      ? { root: taskDirectory.canonical, cwd: taskDirectory.canonical }
      : await this.folders.commandDirectory(run.bot, folder, cwd);
    const scope =
      name === 'workspace_shell' && this.unrestricted(run) ? { unrestricted: true as const } : {};
    return this.commands.invoke(
      {
        id: run.id,
        bot: run.bot,
        sessionId: run.sessionId,
        conversationId: run.conversationId,
        workdir: directory.cwd,
        root: directory.root,
        ...scope,
        abort: run.abort,
        task: run.task,
        waitingForComputer: run.waitingForComputer,
        onComputerWait: run.onComputerWait,
      },
      name,
      args,
      wireId,
      async () => {
        if (taskDirectory) {
          // Approval can outlive the directory named in the card. Recheck the original task lease.
          try {
            await taskDirectory.verify();
          } catch {
            return { isError: true, content: [{ type: 'text', text: 'TASK_DIRECTORY_MOVED' }] };
          }
        } else {
          const current = await this.folders.commandDirectory(run.bot, folder, cwd);
          if (current.root !== directory.root || current.cwd !== directory.cwd)
            throw new Fault('LOCAL_FOLDER_CHANGED');
        }
        return this.execute(
          { command, cwd: directory.cwd, root: directory.root, ...scope },
          run.abort.signal,
        );
      },
    );
  }
}
