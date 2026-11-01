import { type ModelConnection, modelCatalog } from '@daban/protocol';

export function modelName(id: string | undefined, connections?: ModelConnection[]) {
  if (!id) return '默认模型';
  return modelCatalog(connections).find((entry) => entry.id === id)?.name || `${id}（未配置）`;
}

export function modelChoices(connections?: ModelConnection[], selected?: string) {
  const options = modelCatalog(connections).map((entry) => ({
    value: entry.id,
    label: connections
      ? `${connections.find((connection) => connection.id === entry.provider)?.name || entry.provider} · ${entry.name}`
      : entry.name,
    disabled: false,
  }));
  // Keep a saved route visible when its connection is unavailable; never replace it with another supplier.
  if (selected && !options.some((option) => option.value === selected))
    options.push({ value: selected, label: `${selected}（未配置）`, disabled: true });
  return options;
}
