# 开发指南

本页说明源码开发、完整客户端运行与本地打包。产品介绍见 [README](../README.md)，实际使用见[中文使用文档](zh-CN/README.md)或 [English user guide](en/README.md)。

## 环境要求

- Node.js 22.15+（22.x）或 24+，以及 npm；建议使用 Node.js 24。
- Linux 虚拟机模式和 macOS 打包需要 Apple 芯片 Mac；Windows x64 可构建无需 VM 的本机模式。
- 执行模型任务需要所选供应商的 API Key，在客户端设置中填写。

仓库不包含环境镜像、随包后台资源、虚拟机磁盘或用户凭据。仅克隆源码和安装依赖，不会得到完整的 Linux 运行环境。

## 网页预览

在仓库根目录执行：

```sh
npm ci
npm run dev:web
```

访问 <http://127.0.0.1:5173>。此模式只运行渲染层，适合调整界面，不会执行真实模型任务。组件场景、参数与存储隔离说明见 [界面预览](../apps/desktop/preview/README.md)。

如果 Electron 下载失败，可以在安装依赖时指定镜像，保留安装器校验：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_CUSTOM_DIR='{{ version }}' npm ci
```

## 完整 Electron 客户端

开发模式从以下目录读取随包资源，两者都不随 Git 提交：

- `resources/agent/`：宿主机后台服务、生产依赖、独立 Node 和 Linux 执行端代码包。
- `resources/environment/`：经过校验的干净 Linux 环境包及清单。

准备好资源后执行：

```sh
npm run dev
```

该命令先构建再打开 Electron。已有构建可以通过 `npm start` 打开。首次进入按客户端引导创建本地环境，再配置模型；不要将开发机的用户 VM 或凭据复制进资源目录。

## 项目结构

项目使用 npm workspaces，依赖在根目录统一安装。完整目录说明见 [Repository structure](architecture.md)。

```text
apps/desktop/       React 界面、Electron 主进程和预加载
apps/agent/         宿主机后台、DSH、模型配置、审批和 VM 管理
apps/runtime/       Linux 执行服务入口
packages/engine/    按角色划分的实现库
packages/protocol/  公开类型和协议校验
tools/             检查、构建和打包工具
```

客户端通过宿主机后台运行 Agent，Linux VM 负责桌面、浏览器、文件和命令执行。DSH、模型密钥和审批记录保存在 VM 外；关闭客户端不会停止后台任务。

Bot 共用 VM、文件、软件和浏览器登录，但各有独立屏幕与控制权。Bot 可以通过 sudo 管理 VM 内的系统，独立屏幕不构成 Bot 之间的安全隔离。默认不挂载宿主机目录。

应用之间不互相导入；共享代码通过公开包入口访问。构建按协议包、实现库、应用的顺序进行。相关约束见 [AGENTS.md](../AGENTS.md)。

## 模型连接

在设置中添加供应商，每个连接分别保存 API 地址、协议、密钥和多个模型。支持 OpenAI Chat Completions、OpenAI Responses、Claude Messages 和 Gemini GenerateContent；预设会填写相应的协议与地址，仍可添加自定义连接。模型需支持工具调用，图片与整屏观察按各模型明确配置的能力开放。

平台预设包括 OpenAI、Claude、Gemini、Grok、DeepSeek、千问、Kimi、智谱、MiniMax、豆包、硅基流动、OpenRouter、腾讯混元、百度千帆、Groq 和 Together AI。地区、账户或部署专属地址仍需按供应商文档调整。Azure 部署与 AWS Bedrock 等需要额外鉴权参数的平台尚未接入。

Claude 的 API 地址填写根地址（默认 `https://api.anthropic.com`），SDK 会追加 `/v1/messages`；Gemini 默认地址包含 `/v1beta`。两者直接使用原生接口与认证头，密钥不放入 URL。切换接口协议需要重新填写密钥；已有未声明协议的连接继续使用 Chat Completions，未保存的请求和原有配置保留。

连接验证优先读取模型列表；接口不提供列表时，会发送固定的短测试请求，可能产生少量 API 费用，不包含用户对话。工作区默认模型和各 Bot 的模型分别选择，修改从下次任务生效；运行中的任务保留原连接，会话不会跨供应商复用。

联网搜索目前使用已配置的 DeepSeek 官方连接；没有该连接时不启用这项搜索工具，其他供应商仍可运行对话与工作区工具，并按权限读取网页和使用浏览器。供应商密钥不交给 Linux 执行端；风险审核使用任务启动时捕获的模型连接，无法明确判断时请求人工确认。

旧 Linux 执行端继续支持原有 DeepSeek 任务；使用新模型及其图片能力需要更新执行端。新客户端会检查执行端声明的能力，缺失时明确报错，不发送旧版本不认识的字段。

## 常用检查

```sh
npm run lint          # Biome 与源码约束
npm run typecheck     # 严格类型检查
npm test              # 客户端和仓库工具测试
npm run test:agent    # 宿主机后台测试
npm run test:runtime  # 执行与领域服务测试
npm run build         # 构建全部工作区
```

界面文案通过 `apps/desktop/src/i18n/locale.ts` 的类型化翻译入口读取，英文语义 key 在 `apps/desktop/locales/en.ts` 与 `zh-CN.ts` 中成对维护；插值使用 `{0}`、`{1}` 等占位符，不使用中文原文作为 key。只翻译应用自身文案，保留用户内容、模型回复、稳定标识、枚举值和审批参数；历史样例迁移数据不可随文案修改。

格式化使用 `npm run format`。行为变更先写使用合成数据的失败测试，再运行相关检查；不要把真实用户内容或凭据放进测试。

修改独立部署依赖时，同步根 `package-lock.json` 与相关的 `apps/agent/standalone-lock.json` 或 `apps/runtime/standalone-lock.json`。不要依赖开发机的 workspace 链接部署服务。

## 打包 macOS 应用

先准备经过校验的干净环境包和官方 macOS ARM64 Node.js 24.22.1 目录，再执行：

```sh
npm run bundle:desktop -- /absolute/path/to/environment-pack /absolute/path/to/new-output /absolute/path/to/node-24.22.1
```

输出目录必须尚不存在。成功后在该目录生成 `Daban.app`，包含 Electron、界面、宿主机后台及独立 Linux 执行环境，无需用户另外安装 Docker、Node.js 或 DSH。

当前构建器固定使用已封存的 38 版无凭据基础镜像，并叠加当前执行端；环境包须匹配构建器校验，不能任意替换。环境准备与校验代码见 [environment.ts](../tools/environment.ts)、[guest.ts](../tools/guest.ts) 和 [desktop.ts](../tools/desktop.ts)。本地打包使用临时签名；正式发行由 [CI 与 Release](releasing.md) 中的工作流完成 Developer ID 签名和 Apple 公证，应用内更新见[应用更新](zh-CN/updates.md)。

本地临时签名在重新构建后可能改变应用身份，macOS 因而要求重新授予录屏和辅助功能权限。若系统列表中仍显示旧条目已开启，但客户端检测未获授权，需移除 Daban 的旧条目，再添加当前应用并重新打开。公开分发需使用稳定的 Developer ID 签名。

## Windows 本机模式

在 Windows x64 上准备官方 Node.js 24.22.1 目录（含 node.exe 与 LICENSE），然后执行：

```sh
npm ci
npm run bundle:windows -- C:/build/Daban-win-x64 C:/tools/node-v24.22.1-win-x64
```

输出目录必须尚不存在，运行其中的 `Daban.exe`。随包提供后台、DSH 和原生输入组件，无需 Lima、WSL 或 Docker。首次使用直接配置模型；在 Bot 的电脑面板授权本机桌面操作。当前仅控制主显示器和当前用户能操作的应用，不自动通过 UAC 或管理员界面。

本机权限只保存在客户端内存中，按 Bot、模型和连接修订绑定。返回 Daban、锁屏、休眠或按 Ctrl + Alt / Option + Esc 暂停；关闭客户端撤销桌面授权。Windows 命名管道使用校验服务端证书的 TLS，公开证书在成功监听后发布到受 ACL 保护的用户目录，密钥不发送给未验证的监听者。

Windows 本机模式尚无 Linux 工作区的 shell、文件和进程工具，桌面 GUI 仍可操作真实应用与文件。`Native desktop` 工作流构建便携包并运行合成测试；签名和真实 Windows 桌面的手工验收仍需分别完成。

## 数据与本地产物

macOS 的连接配置位于 `~/Library/Application Support/daban-preview/runtime.json`，首次配置由客户端生成。不要为了修复启动问题直接覆盖已有连接、删除 VM 或重置用户目录。

客户端导出不包含完整的后台数据库、工作文件和 VM 磁盘，不能作为完整环境备份。模型密钥不应写入导出、截图、日志或 Git。

`outputs/` 用于本机构建、截图、日志和验收记录；`docs/specs/` 与 `docs/plans/` 是本地工作文档，均不随 Git 提交。历史阶段的实现与验收说明可从 Git 历史查阅。

## DSH 启动诊断

后台在应用数据目录的 `agent/model/dsh-startup.log` 记录 SDK 加载、初始化开始、成功或失败、耗时和任务标识。macOS 默认位置为 `~/Library/Application Support/daban-preview/agent/model/dsh-startup.log`；Windows 位于 `%APPDATA%\daban-preview\agent\model\dsh-startup.log`。

每份汇总日志最多 512 KiB，仅保留当前文件及 `.1`、`.2` 两份备份，总计最多 1.5 MiB。单条记录与启动临时快照均不超过 64 KiB；超量输出标记为截断。临时快照位于该任务的宿主机私有目录，收集后随 SDK 清理回收。

启动快照包含进程、入口脚本、活动资源类型，以及初始化期间的 stderr 和崩溃信息。模型 Key、任务 RPC token、Bearer 凭据在写入前脱敏；不记录环境变量、请求/RPC 正文或正常聊天输出。收到初始化成功响应后立即停止采集。日志不可写不会中断任务，也不会自动延长 40 秒的初始化超时。


## Small clients and optional runtimes

Build the workspace first. Runtime components are separate immutable release assets, keyed by a source/dependency fingerprint. Renderer-only changes reuse the same runtime. Never package a user VM or move an existing runtime tag.

- `tools/component.ts build <new-output> <Node24.22.1-folder> [clean-environment-pack]` builds the host component. Mac requires Developer ID and notarization credentials, and the pack contains only manifest, pinned Lima tools and notices; the Linux image is fetched by the host on explicit installation.
- `tools/component.ts reference <runtime.zip> <reference.json>` pins its size and SHA256 into the client.
- `tools/desktop.ts <reference.json> <new-output>` and `tools/windows.ts <new-output> <reference.json>` assemble small clients.
- The **Signed macOS desktop** workflow can validate signing, notarization and both Mac download formats without publishing a desktop release. **Native desktop** validates Windows component extraction, cached first-use startup and NSIS packaging.

Downloaded Mac code must pass the same publisher requirement as the signed client plus Gatekeeper. Windows checks the pinned archive and extracted host manifest. Host credentials and approvals stay outside Linux. Installing Linux requests an authenticated idle handoff; active jobs finish first. Runtime downloads are separate from the app update feed.
