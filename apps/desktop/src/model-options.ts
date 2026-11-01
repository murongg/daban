import { type ModelConnection, modelCatalog } from '@daban/protocol';
import { createElement } from 'react';
import { ProviderIcon } from './ProviderIcon';
import { providerIdentity } from './platforms';

function icon(provider: string | undefined, connections?: ModelConnection[]) {
  return createElement(ProviderIcon, {
    platform: provider
      ? connections
        ? providerIdentity(connections.find((connection) => connection.id === provider))
        : 'deepseek'
      : 'custom',
  });
}

export function modelIcon(id: string | undefined, connections?: ModelConnection[]) {
  return icon(modelCatalog(connections).find((entry) => entry.id === id)?.provider, connections);
}

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
    icon: icon(entry.provider, connections),
  }));
  // Keep a saved route visible when its connection is unavailable; never replace it with another supplier.
  if (selected && !options.some((option) => option.value === selected))
    options.push({
      value: selected,
      label: `${selected}（未配置）`,
      disabled: true,
      icon: icon(undefined, connections),
    });
  return options;
}
