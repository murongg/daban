import { screen } from '@testing-library/react';
import { t } from '../i18n/locale';

type Actor = { click: (element: Element) => Promise<unknown> };

export async function appAction(actor: Actor, name: string) {
  await actor.click(screen.getByRole('button', { name: t('app.moreActions') }));
  await actor.click(screen.getByRole('menuitem', { name }));
}

export async function workspaceTab(actor: Actor, name: string) {
  if (!screen.queryByRole('tab', { name })) {
    await actor.click(screen.getByRole('button', { name: t('app.workspace') }));
  }
  await actor.click(screen.getByRole('tab', { name }));
}
