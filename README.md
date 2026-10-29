# VS Code Server for BB

Embed a self-hosted [code-server](https://github.com/coder/code-server) or VS Code Server instance in BB's right panel. Each launch opens an independent `VS Code 1`, `VS Code 2`, and so on tab.

## Requirements

- BB 0.41 or later.
- A reachable HTTP or HTTPS code-server or VS Code Server URL.
- The server's authentication and network controls must permit the BB client that will load it.

## Install

Install from the plugin's Git repository after its first release:

```sh
bb plugin install git:https://github.com/GantisStorm/bb-plugin-vscode-server.git@semver:^0.1.0
```

## Configure

Set the URL in BB settings:

```sh
bb plugin config vscode-server set serverUrl https://code.example.com
```

Alternatively, set `VSCODE_SERVER_URL` in BB's server environment. The plugin setting takes precedence. Empty settings and environment values leave the panel unconfigured.

The plugin settings also show the desktop VS Code profile and extension directories, plus the code-server target directories. Saving a loopback URL in the setting—or using **Detect local server**—imports the selected profile and extensions into those target directories. Start code-server with matching `--user-data-dir` and `--extensions-dir` options. Remote URLs embed normally but cannot receive files from this machine. The URL must be absolute HTTP or HTTPS and must not contain credentials; the plugin removes a trailing slash before embedding it.

## Use

In any thread, open the right panel, choose **Open new tab**, then select **VS Code**. A thread has one VS Code panel; reopening it focuses that panel. The panel opens code-server at the thread environment’s workspace; threads without an environment open at their BB thread-storage folder. Its compact header expands when clicked to reveal the server URL, profile import status, and **Open in Browser**. It reloads its configuration when opened; use **Reload configuration** after changing the setting while it is already open. In the plugin settings, turn on **Capture local server** to restore the standard VS Code profile paths, then detect code-server or VS Code Server on ports 8080 and 8000 and save the first healthy endpoint. Turn the switch off to clear every plugin setting. Turn it back on to restore the paths and capture again. When no URL is configured, **Detect local server** in the panel performs the same capture. **Open in Browser** delegates the URL to BB's native Browser, whose tabs remain available across thread navigation.

## Editors on multiple machines

Run an editor on each execution machine, then configure **Editor URLs by machine**
with a JSON object keyed by the IDs from `bb machine list --json`, for example:

```json
{
  "host_m4": "http://127.0.0.1:8000",
  "host_devbox": "https://devbox.example.ts.net:8443"
}
```

The plugin selects the URL using the thread workspace's machine, then supplies
that workspace's folder. Threads without an environment use their thread-storage
machine and folder. With a nonempty mapping, an unconfigured machine shows an
error; it never silently opens the same path on another computer. URLs must be
reachable from the browser displaying BB: loopback works only on the computer
running that editor. Keep remote editors behind private network access and their
appropriate authentication controls.

Each editor manages its own profile; BB's local profile import is not used for
machine-mapped editors. An empty mapping retains the existing single-server
behavior. The new-thread panel continues to use the global server URL until a
thread has a workspace.

## Editor session retention

VS Code stays loaded when switching to another right-panel tab, hiding the
panel, or navigating to another thread. The plugin keeps the iframe connected
in a hidden container and uses `Element.moveBefore()` to restore it without
reloading its document. Separate thread/workspace URLs retain separate sessions;
concurrent panes do not move the editor out of another active pane.

Closing an editor tab releases its iframe. Disabling or reloading the plugin
releases all retained frames. **Reload editor** explicitly starts a fresh
session after confirmation. A full app-window/page reload still ends the
in-memory sessions; code-server's own persistence is unchanged.

This requires a browser supporting `Element.moveBefore()`. Verified with
bb 0.47.1, Electron 44, and Chromium 152. The SDK has no tab-close lifecycle
callback, so cleanup tracks the owning panel's current tab-pill close control;
this integration should be rechecked after bb changes its tab UI.

Validation: `npx vitest run`, `npx tsc --noEmit`, and `bb plugin build`.
The browser check used a signed-in code-server workbench with an unsaved
untitled draft. Info/Browser tab switches, panel hiding, and a round trip
between two workspaces preserved the original iframe and draft with zero
additional loads. Closing one workspace tab released only its iframe, and
plugin reload released all previous frames. The unit tests cover ownership,
workspace isolation, stale route bindings, explicit/keyboard tab close, and
idempotent teardown; jsdom does not model iframe document preservation.

## Development

```sh
npm install
bb plugin build
npx vitest run server.test.ts
bb plugin install .
```

`dist/` is committed because Git installations load the prebuilt plugin artifacts. `bb plugin types` synchronizes development declarations with the BB instance used for development; the checked-in SDK declaration version is the latest published package compatible with the plugin's declared BB runtime requirement.

## Security

The plugin embeds the configured URL in an iframe and copies local profile files only for loopback URLs. It does not proxy requests or weaken the server's existing authentication. Configure code-server with HTTPS and its normal authentication controls when it is accessible outside a trusted network.

## License

[MIT](LICENSE)
