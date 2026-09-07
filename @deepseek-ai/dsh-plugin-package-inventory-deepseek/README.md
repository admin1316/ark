# @deepseek-ai/dsh-plugin-package-inventory-deepseek

English | [中文](README.zh.md)

Official DeepSeek request extension that reports the exact package name and version of active Loader-backed plugins. It reads the live root Loader tree and the addressed session's mounted Agent preset, excludes structural groups, disabled entries, inactive fibers, and loose modules without a package manifest, then emits a deterministic deduplicated `dsh_plugin_packages` list.

## Config

```yaml
- name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
  config:
    enabled: false
```

`enabled` defaults to `true`. Setting it to `false` returns before registration, so no inventory field is prepared or sent. The field contains package names and versions only; it never includes filesystem paths, plugin configuration, credentials, or module source.

## Model Experience

### Active plugin package inventory

#### What the model sees

No prompt content or tool schema. The official DeepSeek endpoint receives one versioned top-level `dsh_plugin_packages` inventory when enabled.

#### Token effect

No model-input token effect under the Harness accounting contract.

#### KV Cache effect

The prompt prefix is unchanged. The provider decides whether out-of-band request metadata participates in cache identity.

## Known Limitations and Deferred Work

- Package identities are cached for the process lifetime; in-process package-version replacement is not supported.
- A configured `deepseek-official` compatible gateway receives the same field because endpoint trust belongs to that route's deployment configuration.
