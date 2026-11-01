import { Menu, type MenuItemConstructorOptions } from 'electron';
import { type Locale, type MessageKey, translate } from '../locale';

export function localizeMenu(locale: Locale) {
  const text = (copy: MessageKey) => translate(locale, copy);
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Daban',
            submenu: [
              { role: 'about' as const, label: text('common.aboutDaban') },
              { type: 'separator' as const },
              { role: 'services' as const, label: text('menu.services') },
              { type: 'separator' as const },
              { role: 'hide' as const, label: text('menu.hideDaban') },
              { role: 'hideOthers' as const, label: text('menu.hideOthers') },
              { role: 'unhide' as const, label: text('menu.showAll') },
              { type: 'separator' as const },
              { role: 'quit' as const, label: text('menu.quitDaban') },
            ],
          },
        ]
      : []),
    { label: text('common.files'), submenu: [{ role: 'close', label: text('menu.closeWindow') }] },
    {
      label: text('common.edit'),
      submenu: [
        { role: 'undo', label: text('menu.undo') },
        { role: 'redo', label: text('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: text('menu.cut') },
        { role: 'copy', label: text('common.copy') },
        { role: 'paste', label: text('menu.paste') },
        { role: 'selectAll', label: text('menu.selectAll') },
      ],
    },
    {
      label: text('menu.view'),
      submenu: [
        { role: 'reload', label: text('menu.reload') },
        { role: 'forceReload', label: text('menu.forceReload') },
        { role: 'toggleDevTools', label: text('menu.developerTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: text('menu.actualSize') },
        { role: 'zoomIn', label: text('menu.zoomIn') },
        { role: 'zoomOut', label: text('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text('menu.toggleFullScreen') },
      ],
    },
    {
      label: text('menu.window'),
      submenu: [
        { role: 'minimize', label: text('menu.minimize') },
        { role: 'zoom', label: text('menu.zoomWindow') },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: text('menu.bringAllFront') },
            ]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
