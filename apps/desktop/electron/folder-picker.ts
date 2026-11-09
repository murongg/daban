import path from 'node:path';

export function suggestedFolderPath(value?: string) {
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return undefined;
  if (value.split(/[\\/]/).includes('..')) return undefined;
  return value;
}

export async function pickFolder(signal: AbortSignal, suggestedPath?: string) {
  const { dialog } = await import('electron');
  const usableSuggestion = suggestedFolderPath(suggestedPath);
  // A suggested location is only a convenience; only the native picker's returned path is connected.
  const result = await dialog.showOpenDialog({
    ...(usableSuggestion ? { defaultPath: usableSuggestion } : {}),
    properties: ['openDirectory'],
  });
  signal.throwIfAborted();
  if (result.canceled || result.filePaths.length !== 1) return null;
  return result.filePaths[0];
}
