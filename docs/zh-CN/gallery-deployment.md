# 独立部署 Bot 广场

[使用文档](README.md) · [English](../en/gallery-deployment.md)

Bot 广场提供网页、模板目录、不可变发布版本、访问令牌和下载 API。Daban 可以添加多个广场来源。已安装 Bot 的运行、模型凭据、个人记忆和任务保存在自己的运行环境中。

前端使用 Next.js App Router 和 React。`next build` 生成静态应用，再由构建脚本复制到 `dist-gallery/web`，供两种部署方式共用。目录和会话在浏览器中通过同源 API 加载，构建过程不会读取账户或私有模板数据。`/bots/<namespace>/<slug>/versions/<version>` 分享链接在运行时解析。Next 启动脚本会输出为同源文件，以保留严格 CSP；独立 Node 包只托管构建产物，不需要启动 Next 服务。

开发前端时，先设置 `GALLERY_PORT=8080`、`GALLERY_PUBLIC_ORIGIN=http://127.0.0.1:3000` 启动 Node API，再运行 `npm run dev --workspace @daban/gallery`，打开 `http://127.0.0.1:3000`。开发服务器将 `/api` 代理到 `http://127.0.0.1:8080`，可用 `GALLERY_DEV_ORIGIN` 修改目标；生产静态页面直接使用当前同源 API。广场独立声明 TypeScript 6 以兼容 Next 编译器 API，仓库其他部分保留 TypeScript 7，均启用严格检查。`.next`、`out` 和 `next-env.d.ts` 属于框架生成文件。

## 两种部署方式

| | Cloudflare | 私有部署 |
| --- | --- | --- |
| API | Workers | Node.js |
| 元数据、权限、会话 | D1，Drizzle ORM | SQLite，Drizzle ORM |
| 发布包 | 私有 R2 bucket | 持久化数据目录 |
| 网页 | Workers Static Assets | 同一 Node 服务 |
| 默认包上限 | 8 MiB | 100 MiB |
| 并发写入 | D1 原子 batch + revision 条件写入 | SQLite 事务 |

两种方式使用同一份 v3 Bot 包和 `/api/v1` 协议。CF 的包上限受 Workers 内存约束；服务器通过 `/.well-known/daban-gallery.json` 公布实际上限。首版 CF 配置最多 8 MiB，可以调低；私有部署可以在 100 MiB 内调低。不需要模型服务、桌面客户端或 Linux VM 才能启动广场。

## GitHub 登录与注册

两种部署都通过 Better Auth 使用同一份 Drizzle 认证表。在 [GitHub 开发者设置](https://github.com/settings/developers)为广场创建 OAuth App，Homepage URL 填广场地址，Authorization callback URL 填 `https://bots.example.test/api/auth/callback/github`，将示例域名换成自己的。开发时使用浏览器的准确地址，例如 `http://127.0.0.1:3000/api/auth/callback/github`。GitHub OAuth App 只有一个回调地址，开发和生产分别创建应用。

| 变量 | 用途 |
| --- | --- |
| GITHUB_CLIENT_ID | OAuth App 的 Client ID |
| GITHUB_CLIENT_SECRET | OAuth App 的 Client Secret，仅服务端使用 |
| BETTER_AUTH_SECRET | 至少 32 字符的随机密钥，可用 `openssl rand -base64 32` 生成 |
| GALLERY_PUBLIC_ORIGIN | 浏览器访问的准确 origin，不带路径或末尾斜杠；两种部署启用 GitHub 时均必填 |
| GALLERY_GITHUB_ADMIN_IDS | 可选，逗号分隔的 GitHub 数字用户 ID，授予全局管理权限 |
| GALLERY_GITHUB_ALLOWED_IDS | 可选，逗号分隔的 GitHub 数字用户 ID，允许注册和登录 |

三个凭据必须一起配置；全部不配时保留原有令牌登录。凭据缺失一部分或 ID 列表非法会使认证初始化失败。密钥不要放入 `NEXT_PUBLIC_*` 前端变量、模板包、Git 或构建日志。

“使用 GitHub 继续”同时完成登录和首次注册，只申请 `read:user`、`user:email`，不申请仓库权限。公开广场默认允许注册，配置允许列表后只允许列表内用户；私有广场要求允许列表或管理员列表，管理员始终允许。列表使用稳定的数字用户 ID，不使用用户名或邮箱；首位注册者不会自动成为管理员。

每个账户分配一个 `gh-<id>` 发布空间，遇到旧空间重名时自动加后缀。旧空间和机器令牌的权限保留，不按同名用户名或邮箱自动认领。管理员仍可通过“使用访问令牌”管理自动化凭据。浏览器会话固定有效 12 小时，退出时从数据库撤销；不提供邮箱密码注册和按邮箱关联账户。广场会话 API 只返回发布权限与 CSRF nonce，不返回 OAuth 凭据或底层会话令牌。

`BETTER_AUTH_SECRET` 用于签名会话并加密保存的提供方令牌，重启和多实例部署应保持一致，与数据库一起妥善备份。CF 部署先应用新增广场 migration；Node 启动自动应用增量迁移。应用创建步骤可参考 [Better Auth GitHub 文档](https://better-auth.com/docs/authentication/github)。

## Cloudflare 部署

先准备自己的 Cloudflare 账户、Workers、D1 与 R2 权限。从项目根目录构建：

```sh
npm ci
npm run build:gallery
cd apps/gallery
npx wrangler login
npx wrangler d1 create daban-gallery
npx wrangler r2 bucket create daban-gallery-packages
```

将 D1 创建结果中的 database_id 填入 `apps/gallery/wrangler.jsonc`，替换全零的本地开发 ID。已有数据库或 bucket 可以直接填写原有资源，不重复创建。保留绑定名称 `DB`、`PACKAGES`、`ASSETS`；R2 bucket 保持私有，不启用公共下载域名。

初始化数据库并配置管理员令牌：

```sh
npx wrangler d1 migrations apply daban-gallery --remote
openssl rand -hex 32
npx wrangler secret put GALLERY_ADMIN_TOKEN
npx wrangler deploy
```

把生成的 64 位十六进制令牌保存到密码管理器，并在 `secret put` 的交互提示中输入同一份令牌。不要把它放到 wrangler.jsonc、Git、部署日志或模板包中。部署后在网页使用该令牌登录，“访问令牌管理”可以发放指定发布空间的只读或发布凭据；新凭据只显示一次，也可按令牌 ID 撤销。管理员引导令牌通过重新设置 secret 轮换，旧管理员会话随之失效。

默认 `GALLERY_READ_MODE=private`，目录和包下载均要求认证。需要公开广场时将配置改为 public，并明确将模板设为公开；public 模式中的 private 模板仍要求权限。在 vars 中设置 `GALLERY_PUBLIC_ORIGIN` 为准确的 HTTPS origin；启用 GitHub 时必填。仅令牌模式未设置时使用请求的 Worker origin。网页与 API 保持同源。

启用 GitHub 时，将 `GALLERY_PUBLIC_ORIGIN`、数字管理员或允许列表写入 `wrangler.jsonc` 的 `vars`，凭据通过 Worker secret 配置，然后重新部署：

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler deploy
```

配置 GitHub 管理员后，`GALLERY_ADMIN_TOKEN` 仍可作为可选的恢复或自动化凭据保留。开发 OAuth 凭据放入被忽略的 `.dev.vars`，使用回调地址与 Wrangler 浏览器地址一致的开发 OAuth App。

本地开发与部署检查：

```sh
npx wrangler d1 migrations apply daban-gallery --local
npx wrangler dev
npx wrangler deploy --dry-run --outdir ../../outputs/gallery-worker
```

本地管理员令牌可放到被忽略的 `.dev.vars`，变量名仍为 `GALLERY_ADMIN_TOKEN`。本地状态由 Wrangler 管理，与远程 D1/R2 分离。dry-run 仅验证打包，不表示已向真实账户部署。

## 私有部署

在项目根目录构建镜像，设置自己使用的 HTTPS 广场地址；TLS 由反向代理终止：

```sh
export GALLERY_PUBLIC_ORIGIN=https://bots.example.test
docker compose -f apps/gallery/compose.yaml up -d --build
docker compose -f apps/gallery/compose.yaml exec gallery node main.js create-token team publisher --admin
```

将示例域名替换为自己的域名。输出的 id 用于撤销，token 用于登录；妥善保存，之后无法找回。镜像以非 root 用户运行，数据卷挂载到 `/data`。示例只把服务绑定到本机 8080 端口，由你自己的代理转发。

```sh
docker compose -f apps/gallery/compose.yaml exec gallery node main.js revoke-token <token-id>
```

也可以不用容器，从根目录运行 `npm run build:gallery`，设置 `GALLERY_DATA_DIR`、`GALLERY_PUBLIC_ORIGIN` 后执行 `npm start --workspace @daban/gallery`。生成可搬运的 Node 包可用 `node --experimental-strip-types tools/gallery.ts`，产物位于 `outputs/gallery-standalone`，包含自己的锁文件和 vendor 依赖；在该目录 `npm ci --omit=dev --ignore-scripts` 后执行 `node main.js`。

私有部署变量：

启用 GitHub 时，在启动 Compose 前导出三个凭据和数字管理员或允许列表，提供的 Compose 文件会传入服务；直接运行 Node 使用同样的环境变量。公网 origin 应与反向代理的 HTTPS 地址一致，代理需保留 Cookie 和回调查询参数；服务端需要能通过 HTTPS 访问 GitHub。

| 变量 | 默认值 |
| --- | --- |
| GALLERY_DATA_DIR | 容器 /data；直接运行时 ./gallery-data |
| GALLERY_PORT | 8080 |
| GALLERY_PUBLIC_ORIGIN | 必填，HTTPS origin；开发允许 loopback HTTP |
| GALLERY_READ_MODE | private |
| GALLERY_MAX_PACKAGE_BYTES | 104857600 |

## 在 Daban 使用

1. 在软件“设置 → Bot 广场”添加广场地址和访问令牌。公开源可不填令牌；Bot 广场页面的“管理来源”可以直接打开这个设置。
2. 在 Bot 广场选择来源并搜索，核对职责、默认工作方式、技能、资料和明确版本，再安装为新 Bot。离线包通过“导入模板包”按需选择和预览。
3. 保存 Bot 资料后，在“模板与版本”生成发布包。默认工作方式单独填写，不自动包含个人记忆。
4. 下载或发布时冻结该版本；内容变化要使用新版本号。同版本、同内容可以重试，不能覆盖不同内容。
5. 已安装 Bot 可以检查更新、查看差异、逐项解决冲突并应用。回滚只恢复模板配置，个人记忆、模型、权限和已完成的外部操作保留。
6. 新增或变化的技能默认停用；回滚到旧技能内容也需要重新核对启用。运行中的任务固定使用启动时的模板内容。

从文件安装的 Bot 可以显式绑定更新源，前提是广场中的当前版本与本地摘要完全相同。来源域名返回不同 sourceId 时停止更新，重新核对来源；不会自动信任同名模板。

关闭窗口不取消服务端已接受的操作。结果不确定时用保留的“核对或重试上次操作”入口，不反复创建新请求。旧版 v1/v2 导入导出继续使用原入口；v3 包需要支持模板版本的新客户端和宿主机。

## 更新与备份

CF 更新先运行构建、应用新增 D1 migration，再部署 Worker；不要更改已发行 SQL。D1 SQL 从 engine 的 gallery schema 生成，构建时同步到 `apps/gallery/migrations`。R2 与 D1 之间没有共同事务：先保存并核对 R2 对象，再用 D1 batch 登记版本；没有数据库发布记录的孤立对象不能通过下载 API 读取。

CF 备份需同时覆盖 D1 数据和 R2 对象，保留 sourceId；不要只备份网页或只导出数据库。恢复后检查已登记包的摘要，确认完整后再开放流量。原生包同样不能替代服务器备份。

私有部署备份先停止服务，再备份完整数据卷，包括 SQLite、WAL、发布包及 sourceId。恢复到空目录，保持目录只对服务账户可写。不要混用桌面工作区、VM 磁盘或浏览器登录目录作为广场数据卷。

## 参考

服务端采用 [D1 batch 的原子事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)，发布包通过 [R2 条件写入](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) 保存；网页使用 [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/)。CF 包大小设置参考 [Workers 内存限制](https://developers.cloudflare.com/workers/platform/limits/)。
