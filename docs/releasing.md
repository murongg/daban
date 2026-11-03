# CI 与 Release / CI and releases

## 提交检查

PR 和 main 的更新自动执行 Linux、macOS 的类型检查、构建、界面与工具测试、宿主机测试，以及 Linux 执行端回归。现有 `Native desktop / windows` 检查保留，验证 Windows 原生组件、私有通信和便携包首次启动。

CI 不使用 Apple 或模型凭据；发行工作流只由版本标签或手动指定的已有版本标签触发。标签必须指向 main 上的提交，且版本与全部 6 个项目包一致。

## 一次性配置

在 [Actions secrets](https://github.com/murongg/daban/settings/secrets/actions) 配置：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERTIFICATE` | 包含私钥的 **Developer ID Application** `.p12` 文件的 Base64 内容 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | 公证使用的 Apple 账户 |
| `APPLE_TEAM_ID` | 对应开发者团队 ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 应用专用密码 |
| `CHANGELOG_API_KEY` | 专供公开更新记录翻译使用的模型 API Key |
| `CHANGELOG_API_URL` | 可选；OpenAI Chat Completions 兼容的 HTTPS API 根地址，默认 `https://api.deepseek.com/v1` |
| `CHANGELOG_MODEL` | 可选；支持 JSON 输出的翻译模型，默认 `deepseek-flash` |

不要把这些值放进代码、Issue、PR、构建产物或日志。不要上传完整的开发机 `.env`。macOS 凭据仅进入签名步骤的临时钥匙串，任务结束后删除；不向 PR 工作流开放。

在 [Actions variables](https://github.com/murongg/daban/settings/variables/actions) 可配置：

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `MACOS_ENVIRONMENT_TAG` | `environment-v38` | 同仓库保存干净环境包的 Release 标签 |

模型仅接收该版本的公开 PR 和提交记录，不接收源码、用户聊天或 Apple 凭据。中英文任一部分生成失败或被截断，Release 均不会发布；不会默默退回只有英文的日志。

### 基础环境包

macOS 安装包包含完整的 Linux 基础环境，Git 仓库不保存这个大文件。先将经干净镜像与首次安装验收的 **38 版**基础包上传到 `MACOS_ENVIRONMENT_TAG` 指定的同仓库 Release，包含：

```text
manifest.json
system.raw.gz
lima.tar.gz
COMPONENTS.md
```

构建器检查固定的基础镜像摘要、组件版本，以及文件长度和 SHA-256。不能用用户当前的 VM、包含登录或密钥的磁盘替代。不要只修改摘要来跳过镜像验证。基础环境改变时，应先升级构建与校验规则再发行。

可以使用已有的经验证环境包，例如：

```sh
gh release create environment-v38 \
  /absolute/path/to/verified-pack/manifest.json \
  /absolute/path/to/verified-pack/system.raw.gz \
  /absolute/path/to/verified-pack/lima.tar.gz \
  /absolute/path/to/verified-pack/COMPONENTS.md \
  --repo murongg/daban --prerelease --title "Linux environment base v38" \
  --notes "Credential-free build input; not a desktop client release."
```

## 发布版本

1. 在 PR 中更新根包及各 workspace 的版本，并同步锁文件，合并 main。
2. 为已合并提交创建并推送标签，例如 `v0.1.0` 或 `v0.1.0-beta.1`。
3. `Release` 自动运行检查、生成双语日志、打包并发布。预发布标签自动标记为 prerelease。

```sh
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Daban v0.1.0"
git push origin v0.1.0
```

也可在 Actions 手动运行 `Release`，输入**已有**标签。任何检查、公证或日志生成失败都会阻止发布。重试不会覆盖已经发布的版本；修改版本内容应创建新版本。

生成产物：

- macOS Apple 芯片：Developer ID 签名、公证并附加票据的 `.dmg`，以及包含已公证应用的 `.zip`。
- Windows x64：已通过首次启动检查的便携 `.zip`，当前未做 Windows Authenticode 签名。
- Windows x64 标准安装器 `.exe`，用于安装及后续应用内更新。
- `CHANGELOG.zh-CN.md`、`CHANGELOG.en.md` 和 `SHA256SUMS.txt`；GitHub Release 正文同时展示两种语言和原始 PR/比较链接。
- 在线更新清单 `latest.yml` / `latest-mac.yml`（预发布版本使用对应频道名）和 `.blockmap`。清单与对应安装包一起上传，不能先单独发布清单。

macOS 过程会签名 Electron、内嵌 Node、原生模块与 Lima，重新固定签名后 Lima 的摘要，再生成宿主机完整性清单和应用外层签名。公证使用 Hardened Runtime；按 [Apple 的发行流程](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)，只提交最外层 DMG，即可取得容器与嵌套应用的票据，避免重复上传整个大包。应用和 DMG 均通过 `stapler validate` 与 Gatekeeper 检查后才上传；ZIP 在应用附票后生成。

当前不构建 Intel Mac 或 Linux 客户端。应用内更新检查稳定版，下载和重启安装由用户确认。Mac 更新配置在签名前写入资源目录；Windows 安装器从独立副本构建，不会把更新配置写进便携目录。普通 CI 不会启动用户 VM、调用真实模型或申请桌面控制权限。

### 更新日志格式

AI 只生成结构化内容，Markdown 标题、列表和空行由发布脚本统一排版：

- 开头用一句话概括本次更新。
- 按「重要变更 → 新增功能 → 体验优化 → 问题修复 → 维护更新」固定顺序展示，省略空分类。
- 每条变更使用单层列表，保留 PR、提交引用及原始链接；重复记录合并，不添加未经记录支持的功能或验证结论。
- 中英文的分类、条目数量和顺序须一致；脚本校验内容结构和各分类条目数量，不符合要求时阻止发布。
- 独立下载文件使用版本作为一级标题、分类作为二级标题；Release 正文使用语言作为二级标题、分类作为三级标题。
- 单语文件固定命名为 `CHANGELOG.zh-CN.md` 和 `CHANGELOG.en.md`，各自只包含对应语言的更新内容，作为 Release 附件发布，方便后续客户端按界面语言读取。
- GitHub 原始记录和比较链接放在正文末尾的「原始记录 / Original change records」折叠区。

## English

PRs and main updates run Linux/macOS quality checks and Windows package acceptance. Version tags trigger `Release`; all six workspace versions must match the tag, and its commit must belong to main. Stable and prerelease tags are supported. The workflow publishes only after checks, bilingual changelog generation, and both desktop builds succeed.

Configure the secrets listed above. Apple secrets must contain a Developer ID Application certificate with its private key, its export password, and valid notarization credentials. They are imported into a temporary signing keychain, removed after the job, and never supplied to PR checks. Set `CHANGELOG_API_KEY`, `CHANGELOG_API_URL`, and `CHANGELOG_MODEL` in Actions secrets. The URL and model are optional and default to `https://api.deepseek.com/v1` and `deepseek-flash`. The configured endpoint receives the API key, model name, and public PR/commit records for translation. Missing, failed, or truncated translations block publication.

Upload the four verified, credential-free environment files above to the same repository's `environment-v38` release, or configure `MACOS_ENVIRONMENT_TAG`. The pinned base image and component checks must pass. Never distribute a used VM or modify expected hashes to accept an unverified image.

Push a matching `vX.Y.Z` or `vX.Y.Z-beta.N` tag after merging its version update to main. An existing tag can also be selected via manual dispatch. Downloads include notarized Apple Silicon DMG/ZIP files, a Windows x64 portable ZIP, both language changelogs, and SHA-256 checksums. Release notes include both languages and the original change links. Existing releases are not overwritten. Windows signing and Intel Mac builds are not included. Installed clients support stable in-app updates; publish the NSIS installer, Mac ZIP, update manifests and blockmaps together. Portable Windows builds remain separate. Mac update configuration is embedded before signing, and ZIP packaging preserves the signed application.

The model returns structured content; the release script controls Markdown layout. Notes start with a one-sentence summary, followed by nonempty categories in this order: Breaking changes, Features, Improvements, Fixes, Maintenance. Each change uses a single-level bullet, merges duplicate records, and retains PR/commit references and source links. Both languages must use matching categories, item counts and item order; structural validation and category counts are checked before publication. Downloaded changelogs use the version as an H1 and categories as H2 headings. The single-language files, `CHANGELOG.zh-CN.md` and `CHANGELOG.en.md`, are published as Release assets so a future client can select notes by interface language. The bilingual Release body uses H2 language headings and H3 categories, with original records and comparison links in a collapsed details section at the end.
