# `@deepseek-ai/dsh-native-api-app`

English | [中文](README.zh.md)

The API-only native desktop bundle over [`dsh-base`](../base/README.md). Its patch mounts only the Host rows required by native clients: storage, feedback, Workspace, projection cache and units, references, directory picking, plugin inventory, knowledge Wiki, the strict Host Remote Gateway, direct Workbench and Session Remote owners, Native event projection, `WebServer`, Host Connection, and Agent presets. It also moves model-facing rows behind per-session presets, parses the optional `--port` argument through [`dsh-cmdline`](../../boot/cmdline/README.md), defaults to an OS-assigned port, and prints the resolved `dsh native-api: http://127.0.0.1:<port>` only after the complete Loader tree settles.

The listener is fixed to loopback, requires the launch-scoped `DSH_API_TOKEN`, and sets `apiOnly: true`. The bundle mounts no frontend fallback, module scanner, Client runner, browser runtime, browser package, UI plugin, Web prompt, shell Web URL, or browser opener. `@deepseek-ai/dsh-host-connection` owns `/api`, `/api/events/mux`, `/api/events/host`, and exact download/response routes without shipping a browser entry; `@deepseek-ai/dsh-api-gateway` is Host-only and owns every dynamically registered strict slash Remote interception.

## Model Experience

Indirectly, through the selected Agent preset; this bundle adds no prompt text or tool schema.

#### KV Cache effect

None directly.

## Known Limitations and Deferred Work

- **One loopback listener** — the bundle intentionally accepts no host or trusted-authority override; a native client must run on the same machine and carry the launch token.
- **Readiness is stdout-based** — an embedding supervisor must parse the exact post-settlement `dsh native-api:` line and reject non-loopback or out-of-range resolved ports.
