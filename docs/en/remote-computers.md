# LAN computer access

The first version connects computers on the same local network. Install matching Daban builds on both devices. Keep the host powered, signed into its desktop and running Daban. The connection service is built into the client; no server deployment, SSH forwarding or TURN setup is required.

## First connection

1. On the host, open **Remote computers → Allow connections to this computer**, then **Enable and generate code**.
2. On the controller, open **Remote computers → Connect another computer**, enter the host’s six digits and connect. During onboarding, use the **Running locally** selector in the header; a local model is not required first.
3. Verify the requesting device on the host and approve it. The controller opens its workspace automatically.

Codes expire after five minutes and are consumed when a new device is approved. Refresh the code on the host after too many attempts or expiry. The digits are not broadcast in plaintext, private keys stay local, and the host still approves every new device.

The operating system may request private-network or local-network permission. Discovery uses local multicast; guest Wi-Fi, multicast isolation and firewall restrictions may prevent discovery.

## Later use

Paired computers remain in the device list. Open their workspace from the list. The selected workspace reconnects after temporary network loss. Models, files, approvals and accepted tasks belong to the host; disconnecting the controller does not cancel accepted work.

Configure the host model, create a Bot, then authorize its native desktop. Desktop tools require a vision-capable model and separate host approval. macOS screen recording and accessibility permissions remain operating-system grants on the host.

Human input checks the device, Bot, session revision and fresh observation. Disconnecting releases that session’s input and leaves human control paused. It does not automatically return control to the Bot. Escape returns keyboard focus to the text field; Alt+Escape sends a remote Escape.

Native live video uses a separate WebRTC connection. Workspace operations use pinned TLS WebSockets and do not depend on ICE or video success. Authorized screenshot control remains available after taking control when video fails. Existing Linux VMs retain their executor and screenshot preview; VM video is outside this change.

## Manage access

**Devices and access** contains full fingerprints, the read-only listening address and saved devices.

- Removing a computer on the controller removes its local connection record.
- Revoking a controller on the host disconnects its sessions, releases input and refuses future access.
- Disabling connections closes the LAN listener without deleting workspace data.

The host window can be closed while connections are enabled. Quitting Daban, signing out or suspension affects desktop access. Add Daban to system login items if needed after reboot. Returning to Daban, Ctrl+Alt+Escape or received lock/suspend events pauses native control. Linux lock-screen integration has not completed physical-device acceptance.

## Compatibility and limits

- Update both apps to the same test build and use a six-digit code for new pairing. Earlier links are no longer used for new devices. Existing identities, models, files and workspace data remain; early records without a certificate still require pairing again.
- The supported network is a mutually reachable IPv4 LAN. Discovery finds Daban hosts with an active pairing code; no account or extra service is required.
- Public-network access, external Connect/TURN services and unattended cloud deployment are outside version one.
- Existing macOS/Windows native drivers are reused. Linux currently supports X11/x86-64; Wayland is unsupported.
- Automated verification uses synthetic content. Two physical devices and native input still require corresponding hardware acceptance.

## Developer verification

`npm run test:remote` uses the production Electron bundler to exercise six-digit pairing, real TLS workspace traffic and synthetic video. Its local coturn is a media-test fixture only; the running client does not need coturn. After `npm run dev:web`, `/preview/remote.html` shows the synthetic interface; use `lang=en` and `theme=dark` for language/theme checks.
