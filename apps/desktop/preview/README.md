# 界面预览

这些页面只使用合成数据和模拟接口，不连接真实模型、虚拟机或外部服务，也不包含在客户端发行包中。

在仓库根目录运行 `npm run dev:web`，再访问下列地址。组件场景放在 `scenes/`，公共入口是 `main.ts`；模型数据与接口模拟集中在 `models.ts`。

| 页面                          | 用途                     | 常用参数                                                |
| ----------------------------- | ------------------------ | ------------------------------------------------------- |
| `/preview/settings.html`      | 完整设置弹窗             | `theme=dark`                                            |
| `/preview/providers.html`     | 供应商与多模型表单       | `empty=1`、`theme=dark`                                 |
| `/preview/controls.html`      | 下拉框、日期、时间等控件 | `theme=dark`                                            |
| `/preview/sidebar.html`       | 侧栏与整理菜单           | `controls=1`、`keep=1`                                  |
| `/preview/chat.html`          | 私聊与历史、待确认操作   | `mode=history`、`busy`、`pending`、`uncertain`          |
| `/preview/group.html`         | 群聊与归档、恢复         | `mode=archived`、`pending`                              |
| `/preview/copy.html`          | Bot 与群聊复制           | `kind=group`、`mode=pending`、`keep=1`                  |
| `/preview/tasks.html`         | 共享任务与讨论           | `mode=discussion`、`discussion-long`、`pending`、`many` |
| `/preview/notes.html`         | 便笺与版本冲突           | `mode=editor`、`conflict`、`pending`、`empty`           |
| `/preview/preferences.html`   | 工作偏好与历史           | `mode=dirty`、`long`、`error`                           |
| `/preview/execution.html`     | 执行记录                 | `mode=group`、`history`、`long`、`incomplete`           |
| `/preview/inputs.html`        | 附件、粘贴与拖入         | `mode=paste`、`hover`、`group`、`error`                 |
| `/preview/notifications.html` | 模拟桌面提醒             | `mode=on`、`task`、`defer`、`unsupported`               |
| `/preview/render.html`        | Markdown、公式与图表     | 使用页面内工具栏                                        |

多个参数用 `&` 连接；表格中 `mode` 后列出的简写也都是该参数的值。大部分页面支持 `theme=dark`；所有页面都可以通过 `lang=en` 或 `lang=zh-CN` 设置各自预览的界面语言。

正常场景使用公开协议的 `managedProtocol`。涉及版本边界的场景支持 `mode=legacy`，原有 `mode=old` 参数在任务、便笺和复制场景中继续保留。

旧 `/preview/comments.html` 地址会重定向到任务页；未指定 `mode` 时默认进入讨论模式，已有查询参数保持原样。

## 存储边界

公共入口先注入独立的会话存储，再加载场景模块。工作区草稿、语言与待确认操作使用按场景区分的 `sessionStorage` 命名空间，不读写普通应用页面的 `localStorage`。同一页面刷新时会话存储保留；支持 `keep=1` 的场景可沿用其草稿和操作记录。关闭浏览器标签后按浏览器会话规则释放这些数据。刷新后若回到对话页，从任务入口或对应面板返回即可继续查看保留的草稿。

新增页面时，HTML 的入口统一使用：

```html
<script type="module" src="/preview/main.ts" data-preview="ExamplePreview"></script>
```

对应场景放在 `scenes/ExamplePreview.tsx`。场景读写客户端缓存时使用 `src/cache.ts` 的 `clientCache()`，不要直接访问 `localStorage`；不要把真实密钥、用户文件或业务内容放进预览数据。
