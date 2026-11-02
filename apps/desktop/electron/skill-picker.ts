import { readSkillSelection } from '@daban/engine/skill-package';
export async function pickSkill(kind: 'directory' | 'file', signal: AbortSignal) {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog({
    properties: kind === 'directory' ? ['openDirectory'] : ['openFile'],
    ...(kind === 'file' ? { filters: [{ name: 'Agent Skills', extensions: ['md', 'zip'] }] } : {}),
  });
  signal.throwIfAborted();
  if (result.canceled || result.filePaths.length !== 1) return null;
  return readSkillSelection(kind, result.filePaths[0], signal);
}
