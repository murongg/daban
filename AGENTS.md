# daban 项目约束

## 源码语言

- 项目自己维护的客户端、Electron 主进程、预加载、Linux 运行时、浏览器脚本和测试全部使用 TypeScript。
- JavaScript 只允许作为构建产物或第三方依赖存在；不得将手写逻辑放进生成目录规避此规则。

## 禁止 void 关键字

- TS / TSX 源码禁止使用 `void` 关键字，包括 `void` 表达式和显式的 `void` 返回类型。
- 异步操作使用 `await`，或提供明确的 `.catch(...)` 错误处理；禁止通过丢弃 Promise 隐藏失败。
- 无返回值函数优先让 TypeScript 推断类型；回调契约可按语义使用 `unknown`，需要表达空值时使用 `undefined`。
- 不得通过关闭严格检查、使用 `@ts-nocheck`、改成 `any` 或漏掉编译入口绕过检查。

## 验证

- `npm run check:source`：维护目录中只允许 TypeScript，并检查实际语法节点中没有禁用关键字。
- `npm run typecheck`：客户端、Electron、Linux 运行时、构建脚本和测试的严格类型检查。
- 修改行为时先写失败测试，使用合成数据；运行相关客户端、运行时及 Linux 集成回归。
- 任务控制权、请求去重和文件访问检查不可被简化掉。关闭窗口不应停止虚拟机内正在执行的任务。

## 可读性与代码检查

- 维护的源码不得手写成压缩式代码，不得把多条独立语句挤在同一行；使用正常缩进、换行和清晰的代码块。
- 使用项目锁定版本的 Biome 统一格式化和 lint：`npm run format`、`npm run lint`。
- 保留严格 TypeScript 和禁用关键字检查；不得通过关闭检查或大范围忽略规则掩盖问题。
- 构建产物和第三方依赖不参与源码格式化。

Biome 保留现有非空断言、CSS 层叠顺序和必要的 `!important` 风格；这些不作为 lint 禁令。正确性与可访问性检查保持开启。远程桌面焦点和弹窗背景的规则例外必须就近说明原因，不得移除键盘退出、焦点管理或控制权检查。

## 工作区边界

- 使用 npm workspaces：`apps/desktop`、`apps/runtime`、`packages/protocol`；仓库工具放在 `tools`。
- 应用的依赖由应用声明；共享协议只通过 `@daban/protocol` 的公开入口导入。禁止应用互相导入、跨工作区相对路径和访问包内部源码。
- 根目录命令按协议包 → 应用的顺序构建；保持现有构建入口和用户数据路径的兼容。
- `apps/runtime/standalone-lock.json` 用于独立 Linux 部署。更新运行时依赖时同步根 lockfile 与独立 lockfile，不依赖开发机 workspace 链接。
