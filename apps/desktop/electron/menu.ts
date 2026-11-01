import { Menu, type MenuItemConstructorOptions } from 'electron';
import { type Locale, translate } from '../locale';

export function localizeMenu(locale: Locale) {
  const text = (copy: string) => translate(locale, copy);
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Daban',
            submenu: [
              { role: 'about' as const, label: text('关于 Daban') },
              { type: 'separator' as const },
              { role: 'services' as const, label: text('服务') },
              { type: 'separator' as const },
              { role: 'hide' as const, label: text('隐藏 Daban') },
              { role: 'hideOthers' as const, label: text('隐藏其他应用') },
              { role: 'unhide' as const, label: text('显示全部') },
              { type: 'separator' as const },
              { role: 'quit' as const, label: text('退出 Daban') },
            ],
          },
        ]
      : []),
    { label: text('文件'), submenu: [{ role: 'close', label: text('关闭窗口') }] },
    {
      label: text('编辑'),
      submenu: [
        { role: 'undo', label: text('撤销') },
        { role: 'redo', label: text('重做') },
        { type: 'separator' },
        { role: 'cut', label: text('剪切') },
        { role: 'copy', label: text('复制') },
        { role: 'paste', label: text('粘贴') },
        { role: 'selectAll', label: text('全选') },
      ],
    },
    {
      label: text('视图'),
      submenu: [
        { role: 'reload', label: text('重新载入') },
        { role: 'forceReload', label: text('强制重新载入') },
        { role: 'toggleDevTools', label: text('开发者工具') },
        { type: 'separator' },
        { role: 'resetZoom', label: text('实际大小') },
        { role: 'zoomIn', label: text('放大') },
        { role: 'zoomOut', label: text('缩小') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text('切换全屏') },
      ],
    },
    {
      label: text('窗口'),
      submenu: [
        { role: 'minimize', label: text('最小化') },
        { role: 'zoom', label: text('缩放') },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: text('前置全部窗口') },
            ]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
