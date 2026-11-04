# Remote computers

A remote computer is a separate Daban workspace. Its Bot, model configuration, files, approvals and accepted tasks live on the host. Closing the controller or losing its network connection leaves accepted tasks running on the host. Keep the host powered, online and signed into its desktop session.

## Connect an idle computer

1. Install matching builds with remote support on both computers.
2. Open **Remote computers** in each sidebar and record both full device fingerprints.
3. Deploy your Connect service as described below. On the host, enter its HTTPS origin, enable remote access and create an invitation.
4. Paste the invitation on the controller. Verify its fingerprint on the host before approving. Invitations expire after five minutes and do not authorize access on their own.
5. Open the host workspace, configure its model, create a Bot and start a task.
6. Connecting a Bot to the native desktop requires separate host approval of the Bot, model and screenshot recipient. macOS screen recording and accessibility permissions must be granted on the host.

After enabling remote access, the host window can be closed. Add Daban to the operating system’s login startup items to reconnect after reboot. Quitting Daban or signing out disconnects desktop access.

Device keys and pairing records are stored in private host directories. Revoking a device disconnects its sessions. Connect enrollment does not replace host approval.

## View and take control

Native desktops use a separate WebRTC video connection. Start live video and approve viewing on the host. Human input still passes through Daban's ownership and fresh-observation checks. After taking control, use the screen or text input. Escape returns keyboard focus to the text field; Alt+Escape sends a remote Escape.

Authorized screenshots remain available when video fails. Closing video or disconnecting does not automatically return control to the Bot. Returning to Daban on the host, Ctrl+Alt+Escape, or a received lock/suspend event pauses native control and clears temporary consent. Linux lock-screen integration has not completed physical-device acceptance.

Existing Linux VM workspaces retain their executor and screenshot preview. This implementation streams native desktops, including the dedicated cloud desktop below.

## Linux cloud server

`apps/desktop/compose.cloud.yml` runs a dedicated X11 desktop and Daban Host without a main window. It uses the native control path, with no nested VM or mounted server desktop. A named volume retains the workspace.

From the repository root:

```sh
export DABAN_CONNECT_SERVER=https://connect.example.com
docker compose -f apps/desktop/compose.cloud.yml up -d --build
docker compose -f apps/desktop/compose.cloud.yml exec computer node --experimental-strip-types tools/remote.ts --data /data/daban status
```

This entry requires Linux x86-64, Docker and a working Chromium sandbox. Rootless Docker is recommended. A prebuilt cloud image has not been published. Do not disable the Chromium sandbox to bypass installation failures.

Alternatively, run `tools/cloud.ts` as a dedicated Linux user without nested container sandboxing. Install the desktop dependencies listed in the Dockerfile, the pinned Node/npm dependencies, and build Agent and desktop. `apps/desktop/cloud.service` is a systemd user-service template, assuming `/opt/daban` and `/usr/local/bin/node`; adjust those paths. In that user's `~/.config/daban/host.env`, set `DABAN_CONNECT_SERVER`, `DABAN_CLOUD_DATA` (an absolute private directory owned by this user), `DABAN_AGENT_NODE` and `DABAN_AGENT_ENTRY`. Enable the user service and have an administrator enable lingering for that dedicated user to survive SSH logout. Keep unrelated server credentials outside this native desktop user's account.

Use the following commands through SSH, prefixed with the `compose exec computer` command above. Administration uses a private, owner-only Unix socket with no network management port:

```sh
node --experimental-strip-types tools/remote.ts --data /data/daban invite
node --experimental-strip-types tools/remote.ts --data /data/daban status
node --experimental-strip-types tools/remote.ts --data /data/daban approve PAIR_REQUEST_ID
node --experimental-strip-types tools/remote.ts --data /data/daban grant APPROVAL_ID
node --experimental-strip-types tools/remote.ts --data /data/daban pause
node --experimental-strip-types tools/remote.ts --data /data/daban revoke DEVICE_FINGERPRINT
```

`host.remote.pending` contains pairing requests, handled with `approve` / `reject`. Top-level `approvals` contains native-control and video requests, including the device, Bot, model and available recipient details. Use `grant` / `deny` within 25 seconds. Keep an SSH status view ready before requesting access on the controller. `pause` denies pending approvals, stops video and releases input.

## Connect and TURN

`apps/connect/compose.yml` provides Connect, Caddy TLS and coturn. You need a signaling domain and a public TURN address reachable by both devices.

1. Copy `apps/connect/turnserver.example.conf` to a private file outside the repository. Replace its realm, shared random secret and, when needed, public/private IP mapping. Keep this secret only on Connect and coturn.
2. Set `CONNECT_DOMAIN`, `CONNECT_DEVICES` (both full fingerprints, comma-separated), `TURN_SECRET`, `TURN_URLS` and `TURN_CONFIG` (the absolute config path). For example: `TURN_URLS=stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp`.
3. Run `docker compose -f apps/connect/compose.yml up -d --build`. Allow TCP 80/443, UDP/TCP 3478 and UDP 49160–49200. The sample limits allocations and bandwidth; it does not provide TURN TLS.
4. Update enrollment and recreate Connect when adding devices. Each host still requires its own pairing approval.

Connect forwards signed signaling and issues ten-minute TURN credentials. It does not execute Bot commands. Business traffic and video use separate encrypted WebRTC connections, with direct transport when possible and TURN when needed. Keep plain Connect HTTP, private Agent / Runtime endpoints and administration sockets off the public network.

See the [official coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

## Verification limits

- Automated checks cover pairing, revocation, request deduplication, lease fencing, Host-scoped caches, real Chromium + coturn transport, chunked messages, synthetic video rendering and synthetic task completion after controller shutdown.
- Native macOS / Windows drivers are reused. Linux adds X11 support; Wayland is unsupported and the distributed Linux native binary currently targets x86-64.
- The cloud image build was blocked by a full local Docker disk. Sandbox, desktop startup and restart acceptance remain unverified. No real personal desktop was operated in this run. Native input on all three platforms and two-machine public-network acceptance still require corresponding test devices. Verify on dedicated test computers before using a daily desktop.
