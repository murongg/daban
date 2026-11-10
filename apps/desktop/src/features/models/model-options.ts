import {
  localCodexModel,
  type ModelConnection,
  modelCatalog,
  modelReference,
} from '@daban/protocol';
import { createElement } from 'react';
import type { SelectOption } from '../../components/controls/Select';
import { t } from '../../i18n/locale';
import { ModelIcon } from './ModelIcon';
import { ModelInputs } from './ModelInputs';
import { providerIdentity } from './platforms';

function definition(id: string | undefined, connections?: ModelConnection[]) {
  for (const connection of connections ?? []) {
    const model = connection.models.find((model) => modelReference(connection.id, model.id) === id);
    if (model) return { connection, model };
  }
}
export function modelIcon(id: string | undefined, connections?: ModelConnection[]) {
  const entry = definition(id, connections);
  return createElement(ModelIcon, {
    id: entry?.model.id ?? id,
    fallback: entry ? providerIdentity(entry.connection) : 'custom',
  });
}
export function modelInputs(id: string | undefined, connections?: ModelConnection[]) {
  const option = modelCatalog(connections).find((entry) => entry.id === id);
  if (!option) return undefined;
  return createElement(ModelInputs, {
    input: definition(id, connections)?.model.capabilities?.input,
    vision: option.vision,
  });
}

export function modelName(id: string | undefined, connections?: ModelConnection[]) {
  if (!id) return t('modeloptions.defaultModel');
  if (id === localCodexModel) return t('models.localCodex');
  return (
    modelCatalog(connections).find((entry) => entry.id === id)?.name ||
    t('modeloptions.notConfigured', { 0: id })
  );
}

export function modelChoices(connections?: ModelConnection[], selected?: string, cli = false) {
  const options: SelectOption[] =
    connections === undefined
      ? modelCatalog().map((entry) => ({
          value: entry.id,
          label: entry.name,
          disabled: false,
          icon: createElement(ModelIcon, { id: entry.id }),
          detail: createElement(ModelInputs, { vision: entry.vision }),
        }))
      : connections.flatMap((connection) =>
          connection.models.map((model) => ({
            value: modelReference(connection.id, model.id),
            label: model.name,
            description: connection.name,
            disabled: false,
            icon: createElement(ModelIcon, {
              id: model.id,
              fallback: providerIdentity(connection),
            }),
            detail: createElement(ModelInputs, {
              input: model.capabilities?.input,
              vision: model.vision,
            }),
          })),
        );
  if (cli)
    options.push({
      value: localCodexModel,
      label: t('models.localCodex'),
      description: t('models.localCodexHint'),
    });
  // Keep a saved route visible when its connection is unavailable; never replace it with another supplier.
  if (selected && !options.some((option) => option.value === selected))
    options.push({
      value: selected,
      label: modelName(selected, connections),
      disabled: true,
      icon: modelIcon(undefined, connections),
      detail: undefined,
    });
  return options;
}
