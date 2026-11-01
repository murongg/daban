# 开发指南

本页说明源码开发、完整客户端运行与本地打包。产品介绍和使用入口见 [README](../README.md)。

## 环境要求

- Node.js 22.15+（22.x）或 24+，以及 npm；建议使用 Node.js 24。
- 完整客户端和当前打包流程需要 Apple 芯片 Mac。
- 执行模型任务需要自己的 DeepSeek 官方 API Key，在客户端设置中填写。

仓库不包含环境镜像、随包后台资源、虚拟机磁盘或用户凭据。仅克隆源码和安装依赖，不会得到完整的 Linux 运行环境。

## 网页预览

在仓库根目录执行：

```sh
npm ci
npm run dev:web
```

访问 <http://127.0.0.1:5173>。此模式只运行渲染层，适合调整界面，不会执行真实模型任务。

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

项目使用 npm workspaces，依赖在根目录统一安装。

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

## 常用检查

```sh
npm run lint          # Biome 与源码约束
npm run typecheck     # 严格类型检查
npm test              # 客户端和仓库工具测试
npm run test:agent    # 宿主机后台测试
npm run test:runtime  # 执行与领域服务测试
npm run build         # 构建全部工作区
```

格式化使用 `npm run format`。行为变更先写使用合成数据的失败测试，再运行相关检查；不要把真实用户内容或凭据放进测试。

修改独立部署依赖时，同步根 `package-lock.json` 与相关的 `apps/agent/standalone-lock.json` 或 `apps/runtime/standalone-lock.json`。不要依赖开发机的 workspace 链接部署服务。

## 打包 macOS 应用

先准备经过校验的干净环境包和官方 macOS ARM64 Node.js 24.22.1 目录，再执行：

```sh
npm run bundle:desktop -- /absolute/path/to/environment-pack /absolute/path/to/new-output /absolute/path/to/node-24.22.1
```

输出目录必须尚不存在。成功后在该目录生成 `daban.app`，包含 Electron、界面、宿主机后台及独立 Linux 执行环境，无需用户另外安装 Docker、Node.js 或 DSH。

当前构建器固定使用已封存的 38 版无凭据基础镜像，并叠加当前执行端；环境包须匹配构建器校验，不能任意替换。环境准备与校验代码见 [environment.ts](../tools/environment.ts)、[guest.ts](../tools/guest.ts) 和 [desktop.ts](../tools/desktop.ts)。本地打包尚不代表完成公开发行签名、公证或自动更新。

## 数据与本地产物

macOS 的连接配置位于 `~/Library/Application Support/daban-preview/runtime.json`，首次配置由客户端生成。不要为了修复启动问题直接覆盖已有连接、删除 VM 或重置用户目录。

客户端导出不包含完整的后台数据库、工作文件和 VM 磁盘，不能作为完整环境备份。模型密钥不应写入导出、截图、日志或 Git。

`outputs/` 用于本机构建、截图、日志和验收记录；`docs/specs/` 与 `docs/plans/` 是本地工作文档，均不随 Git 提交。历史阶段的实现与验收说明可从 Git 历史查阅。
