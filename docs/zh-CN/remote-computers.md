# 远程电脑

Daban 可以把另一台电脑作为独立工作区。Bot、模型配置、文件、审批和任务都保留在受控端；控制端关闭窗口或断网后，受控端已接收的任务继续执行。受控端需要保持开机、联网和登录桌面。

## 接入自己的闲置电脑

1. 两端安装包含远程功能的同版本 Daban。
2. 在两端侧栏打开“远程电脑”，记录各自的完整设备指纹。
3. 准备自己的 Connect 服务，见下方部署说明。受控端填写 HTTPS 服务地址，启用远程接入并创建邀请。
4. 控制端粘贴邀请并请求配对。受控端核对控制端指纹后批准。邀请有效期为五分钟，邀请本身不会授予访问权。
5. 控制端打开该电脑的工作区，配置远端模型、创建 Bot 并发送任务。
6. Bot 第一次连接原生桌面时，受控端还会确认 Bot、模型和截图接收方。macOS 的屏幕录制、辅助功能权限必须在受控端完成。

启用远程接入后可以关闭受控端窗口。要在重启后继续接入，可在系统登录启动项中启动 Daban；退出 Daban 或注销用户会话会断开桌面连接。

设备身份和配对记录保存在受控端私有目录。移除或吊销设备会断开其会话；网络服务的登记名单不能代替受控端的配对批准。

## 观看和接管

原生桌面支持独立 WebRTC 视频连接。点击“开启实时画面”，在受控端批准观看后播放。键鼠输入仍经过 Daban 的控制权和新鲜观察校验。人工接管后，使用画面或文字输入栏操作；普通 Escape 把键盘焦点移回文字框，Alt+Escape 可发送远端 Escape。

视频失败时可使用授权截图回退。关闭视频或控制端断线不会自动把电脑交还 Bot。受控端回到 Daban、按下 Ctrl+Alt+Escape，或收到系统锁屏 / 休眠事件时，会暂停原生操作并撤销临时授权。Linux 的锁屏联动尚未完成实机验收。

现有 Linux 虚拟机工作区仍使用自己的执行器和截图预览；本次实时视频用于原生桌面，包括下面的云端专用桌面。

## Linux 云服务器

云端入口位于 `apps/desktop/compose.cloud.yml`。它运行专用 X11 桌面和无主窗口的 Daban Host，复用原生控制通道；不安装嵌套虚拟机，也不把服务器真实桌面挂入容器。工作数据放在命名卷中。

在仓库根目录设置服务地址并启动：

```sh
export DABAN_CONNECT_SERVER=https://connect.example.com
docker compose -f apps/desktop/compose.cloud.yml up -d --build
docker compose -f apps/desktop/compose.cloud.yml exec computer node --experimental-strip-types tools/remote.ts --data /data/daban status
```

该入口需要 Linux x86-64、Docker 和可用的 Chromium 沙箱；推荐 rootless Docker。没有发布预构建云端镜像。不要通过关闭 Chromium 沙箱解决安装失败。

也可在专用 Linux 用户下直接运行 `tools/cloud.ts`，避免容器嵌套沙箱的限制。安装与 Dockerfile 相同的桌面依赖、仓库固定版本 Node 和 npm 依赖，构建 Agent 与桌面客户端。`apps/desktop/cloud.service` 是 systemd 用户服务模板，默认仓库在 `/opt/daban`、Node 在 `/usr/local/bin/node`；按实际路径调整。在该用户的 `~/.config/daban/host.env` 设置 `DABAN_CONNECT_SERVER`、`DABAN_CLOUD_DATA`（该用户拥有的私有绝对路径）、`DABAN_AGENT_NODE`、`DABAN_AGENT_ENTRY`。启用用户服务，并由管理员为该专用用户启用 linger 后，SSH 注销不会关闭 Host。不要将该原生桌面用户与服务器上的其他凭据共用。

通过 SSH 使用私有管理接口，命令只连接受保护的本机 Unix socket，不开放管理端口：

```sh
# 以下命令均在上方 compose exec computer 后执行
node --experimental-strip-types tools/remote.ts --data /data/daban invite
node --experimental-strip-types tools/remote.ts --data /data/daban status
node --experimental-strip-types tools/remote.ts --data /data/daban approve PAIR_REQUEST_ID
node --experimental-strip-types tools/remote.ts --data /data/daban grant APPROVAL_ID
node --experimental-strip-types tools/remote.ts --data /data/daban pause
node --experimental-strip-types tools/remote.ts --data /data/daban revoke DEVICE_FINGERPRINT
```

`status` 中的 `host.remote.pending` 是配对请求，使用 `approve` / `reject`。顶层 `approvals` 是原生桌面或视频观看授权，包含设备、Bot、模型及可用的接收方信息，使用 `grant` / `deny`；这些授权请求在 25 秒后过期。先在 SSH 终端查看状态，再在控制端发起操作。`pause` 会拒绝待批准请求、停流并释放键鼠。

## Connect 与 TURN 部署

部署模板位于 `apps/connect/compose.yml`，包含 Connect、Caddy TLS 和 coturn。需要一个指向服务器的信令域名，以及可供两端访问的公网 TURN 地址。

1. 将 `apps/connect/turnserver.example.conf` 复制到仓库外的私有配置文件，替换 realm、随机共享密钥以及需要时的公网 / 私网 IP 映射。该密钥只放在 Connect 和 coturn，不能放入邀请或客户端。
2. 设置 `CONNECT_DOMAIN`、`CONNECT_DEVICES`（逗号分隔的两端完整指纹）、`TURN_SECRET`、`TURN_URLS`、`TURN_CONFIG`（配置文件绝对路径）。例如 `TURN_URLS=stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp`。
3. 启动 `docker compose -f apps/connect/compose.yml up -d --build`。开放 TCP 80/443、UDP/TCP 3478、UDP 49160–49200。TURN 使用示例中的有界连接和带宽配额；示例不提供 TURN TLS。
4. 新增设备时更新登记名单并重建 Connect。已有设备仍须在每个受控端单独配对。

Connect 仅转发签名信令并签发十分钟 TURN 凭证，不执行 Bot 命令。业务和视频通过独立的加密 WebRTC 连接传输；可直连时直连，需要时经 TURN。公网部署不得直接暴露 Connect 的 HTTP 监听、Agent / Runtime 私有接口或管理 socket。

coturn 配置项参考[官方配置说明](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)。

## 当前验证边界

- 自动化验证覆盖配对审批、设备吊销、请求去重、旧租约拒绝、Host 缓存隔离、真实 Chromium + coturn 传输、大消息分块、合成视频渲染，以及控制端关闭后合成任务继续完成。
- 原生驱动复用 macOS / Windows 实现，Linux 新增 X11 路径。Linux Wayland 尚不支持；Linux 原生驱动当前分发二进制为 x86-64。
- 云端容器构建验证被本机 Docker 磁盘已满阻断，尚未完成沙箱、桌面启动和重启后的实机验收。此次没有操作真实个人桌面；三平台原生键鼠及跨公网两机验收仍需在对应设备完成。请先在专用测试电脑验证，再接入日常桌面。
