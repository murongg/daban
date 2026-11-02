# App updates

Official Apple Silicon macOS releases and installed Windows x64 clients can check for stable updates in **Settings → About**. The app also checks after startup. New versions are announced without automatically downloading a large package or interrupting tasks.

## Download and install

1. Select **Check for updates** and review the version and release notes.
2. Select **Download update**. Downloads can be cancelled or retried without changing the current version.
3. Save unsubmitted settings and unsaved work in desktop applications.
4. Select **Restart and install**, then confirm. Workspace chat drafts are saved again before installation.

Active Bot tasks, environment setup, recovery and other in-flight operations block installation. Finish them and try again. A workspace storage failure also cancels the restart; export your workspace first if necessary.

The update cleanly shuts down the idle host service and relaunches the client. It preserves the VM, work files, model configuration and chat database. Linux remains running, although computer connections may briefly disconnect. Save external application work before installing.

## Supported builds

- macOS: a Developer ID release with update configuration. The app in its ZIP and its DMG are notarized.
- Windows: the per-user x64 installer. Portable ZIP builds are not replaced in place; install the standard client instead.
- Development mode, browser previews and older ad-hoc prototypes do not provide online installation. Install an update-enabled release manually once.

Updates come from the project's GitHub Releases. Downloads are integrity-checked, and macOS verifies the application signature. Update checks do not call a model API or send chats or work files. Before the first stable client release, the app reports that no stable release is available.
