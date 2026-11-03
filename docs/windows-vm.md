# Windows Linux 电脑

完整 Windows 环境安装包包含 QEMU、Debian 13 x64、桌面、Chromium 和执行服务，无需另装虚拟机软件或填写连接参数。轻量客户端只包含本机功能，添加 Linux 需要完整环境包。

## 普通安装

1. 安装完整 Windows 包，打开搭伴并配置模型。在 Bot 的「电脑 → Linux 虚拟机」面板，或「设置 → 电脑权限」中点击「安装 Linux 电脑」。
2. 默认使用 QEMU + Windows Hypervisor Platform（WHPX）硬件加速。需要开启功能时，Windows 会请求管理员授权；应用只启用 `HypervisorPlatform`，不会自动重启电脑。
3. 系统要求重启时，先保存其他应用的工作。可点击「重启 Windows…」并确认，也可稍后自行重启。重启后打开搭伴，已请求且未暂停的安装会继续。功能已经可用时无需重启。
4. 不想重启时，展开「其他安装方式」，主动选择「使用兼容模式（较慢）」。它使用 QEMU TCG，桌面、浏览器和任务工具保持相同接口，但速度较慢、CPU 占用较高。应用不会静默切换加速方式。
5. 安装界面显示实际检查、解压、创建、启动和连接阶段。可暂停、继续或重试；重试保留现有磁盘和身份，不会覆盖任务文件或重复创建已启动的电脑。

运行时默认分配 4 个 CPU、6 GiB 内存和 64 GiB 动态虚拟磁盘。安装前界面检查当前磁盘空间；磁盘随后按实际使用增长。首次安装适用于 Intel/AMD x64 Windows；ARM64 环境包不在此实现范围内。

后台服务、VM 和已接受的 Linux 任务不依附客户端窗口。退出客户端撤销本机桌面授权，但不会关停 VM；休眠、Windows 重启和关机会中断本机执行。重启按钮会先通过后台的空闲检查，有任务、恢复操作或安装运行时拒绝重启。

QEMU 只将 SSH 和经过双向 TLS 认证的控制接口绑定到 Windows 回环地址。每次新安装生成独立 SSH 登录密钥、固定来宾主机公钥及控制证书；镜像不含登录凭据、浏览器状态或任务数据。模型和审批仍在 Windows，默认不共享 Windows 文件夹。

## 高级：手动连接 Hyper-V

已有手动 Hyper-V 环境可继续使用「设置 → 电脑权限 → 高级：手动连接 Hyper-V」。此入口不迁移或自动创建已有 VM。搭伴管理的 QEMU 连接不显示为可编辑的 Hyper-V 表单。

## 1. 准备 Hyper-V 虚拟机

在支持 Hyper-V 的 Windows 11 专业版或企业版上启用 Hyper-V，并按系统要求重启。参考 [Microsoft Hyper-V 安装说明](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/Install-Hyper-V)。Daban 不自动提权；当前 Windows 账户须有管理该 VM 的权限。

用 Hyper-V 管理器创建第二代虚拟机，例如 `Daban-Linux`，安装 Debian 13 amd64。可先分配 4 个 CPU、4–8 GiB 内存及 64 GiB 动态磁盘，按任务调整。使用私有 NAT 网络或默认交换机，并确认 Windows 能访问虚拟机的 SSH 端口。Linux 执行 API 始终只监听虚拟机内的 `127.0.0.1:8766`，无需对外开放此端口。

使用独立虚拟磁盘，不共享 Windows 磁盘、文件夹或凭据；不要配置增强会话的磁盘重定向。不要使用 macOS 的 ARM64 镜像。Debian 安装时创建登录用户（下文使用 `daban`），安装 SSH server，记录虚拟机 IPv4 地址。安装器后续会提供桌面、浏览器和 Hyper-V 集成依赖。

在 Windows PowerShell 中查询固定的 VM ID：

```powershell
Get-VM -Name 'Daban-Linux' | Select-Object Name, Id, State
```

VM ID 绑定电源操作；地址可随 DHCP 改变。仅在用户主动连接/恢复时允许启动该 VM，普通断线重连不会唤醒已停止的 VM。

## 2. 配置专用 SSH 密钥

在 Windows 用户自己的 `.ssh` 私有目录中准备专用 Ed25519 登录密钥。后台需要无交互登录，因此使用专用无口令密钥，并保持私钥及所在目录只有当前账户、SYSTEM 和管理员可访问。不要将私钥放入共享、同步或下载目录。

将登录公钥加入 Debian 用户 `daban` 的 `~/.ssh/authorized_keys`，保持 `.ssh` 为 `700`、文件为 `600`。通过虚拟机控制台核对主机公钥：

```sh
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

设置中填写这一行的 `ssh-ed25519` 和公钥部分；尾部注释可保留。主机公钥与 Windows 登录私钥是两种不同用途的密钥。Daban 使用显式主机公钥校验，不自动接受新主机、不使用 SSH agent，也不转发 agent 或 X11。

## 3. 构建 Linux 执行端包

在仓库根目录执行：

```powershell
npm run build:runtime
node --experimental-strip-types tools/linux.ts bundle outputs/linux-executor
```

输出目录必须尚不存在。产物为 `daban-executor-linux-x64.tar.gz` 及 `.sha256` 文件；其中只有独立 Linux 执行端、生产依赖清单、许可证和 TypeScript 安装器，不包含模型 SDK、宿主配置、用户 VM 或凭据。

将两个文件通过已核对主机身份的 SSH/SCP 连接传到 Debian，校验并解压：

```sh
sha256sum -c daban-executor-linux-x64.tar.gz.sha256
tar -xzf daban-executor-linux-x64.tar.gz
```

在 Debian 安装官方 Node.js 24（推荐项目固定的 `24.22.1`），并核对官方校验和。示例：

```sh
curl -fLO https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz
curl -fLO https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
grep ' node-v24.22.1-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
sudo tar -xJf node-v24.22.1-linux-x64.tar.xz -C /opt
sudo /opt/node-v24.22.1-linux-x64/bin/node --experimental-strip-types runtime/install.ts install daban
```

安装器仅支持 Debian 13 x64，必须在该专用 VM 中以 root 执行。它安装桌面依赖、Chromium 和执行服务，创建独立服务账户，并赋予 VM 内任务所需的 sudo 权限；SSH 登录用户只用于受控通道。服务目录为 `/opt/daban-executor`，工作文件和执行凭据位于 `/var/lib/daban-executor`。Node 安装目录须长期保留。

安装器拒绝覆盖已有服务、执行端数据、sudo 配置或服务账户目录。建议安装前创建 VM 检查点；失败时保留日志并检查原因，不要删除现有工作区来强行重装。

检查服务：

```sh
systemctl status daban-executor.service
sudo journalctl -u daban-executor.service -n 50 --no-pager
```

## 4. 在 Daban 中连接

使用包含此功能的新客户端和配套宿主运行组件。在「设置 → 电脑权限 → Hyper-V Linux 电脑」填写：

| 字段 | 内容 |
| --- | --- |
| Hyper-V 虚拟机 ID | 第 1 步查询的 GUID |
| 虚拟机地址 | Debian 的 IPv4 地址或主机名 |
| SSH 用户名 | `daban`，或安装时传入的登录用户 |
| SSH 私钥路径 | Windows 本机专用登录私钥的绝对路径 |
| SSH 端口 | 默认 `22` |
| SSH 主机公钥 | 从 Debian 控制台核对的 Ed25519 主机公钥 |

点击「保存并连接虚拟机」。切换前后台必须空闲；正在执行任务、安装或恢复时会拒绝切换并保留表单。成功后可继续使用现有电脑面板中的 Linux 桌面、文件、命令及人工接管功能。

「返回本机模式」保留 VM 配置和 Linux 文件，不停止虚拟机。关闭客户端会撤销本机桌面授权，宿主服务和已接受的 Linux 任务继续运行。Windows 休眠或关机期间无法持续执行。

工作区恢复记录绑定 VM ID、主机公钥和 SSH 用户。修改 IP 或登录私钥路径可重连；更换 VM 身份不能复用另一台执行端的任务/恢复记录，应使用独立工作区，不能删除记录绕过检查。

## 验证范围

托管 QEMU + WHPX 已在 Windows 11 x64 实机验证完整包安装、Linux 桌面键盘与文件操作、Chromium、控制权交接、关闭客户端后的后台任务，以及 VM 正常启停后文件保留。首次安装生成新的专用 VM 身份和连接信息；模型供应商配置由用户自行完成。

自动测试覆盖参数拒绝、主机公钥固定、环境过滤、加密 Windows IPC、后台模式切换、忙碌拒绝、恢复记录和关窗后连接所有权。真实 Hyper-V 启停、Debian 安装、桌面和持续任务仍需要在已启用 Hyper-V 的 Windows 主机上完成验收；仅通过合成测试不代表真实 VM 已验证。
