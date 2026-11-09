import { isFolderCommand, validAgentId } from '@daban/protocol';
import { Fault } from './control.js';
import type { Folders } from './folders.js';
import type { BotProfiles } from './profiles.js';

export async function folderRequest(
  folders: Folders,
  profiles: BotProfiles,
  action: string,
  data: Record<string, unknown>,
) {
  if (Object.hasOwn(data, 'type')) throw new Fault('INVALID_LOCAL_FILE_ARGS', 400);
  if (action === 'connect') {
    if (
      Object.keys(data).some((key) => !['bot', 'path'].includes(key)) ||
      !validAgentId(data.bot) ||
      typeof data.path !== 'string'
    )
      throw new Fault('INVALID_LOCAL_FILE_ARGS', 400);
    profiles.assertRegistered(data.bot);
    profiles.assertActive(data.bot);
    return folders.connect(data.bot, data.path);
  }
  const command = { ...data, type: `folders.${action}` };
  if (!isFolderCommand(command) || command.type === 'folders.pick')
    throw new Fault('INVALID_LOCAL_FILE_ARGS', 400);
  profiles.assertRegistered(command.bot);
  if (command.type === 'folders.status') return folders.status(command.bot);
  if (command.type === 'folders.disconnect') return folders.disconnect(command.bot, command.id);
  profiles.assertActive(command.bot);
  return folders.restore(command.bot, command.id);
}
