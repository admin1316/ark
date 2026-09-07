# Run a headless task

English | [中文](index.zh.md)

The headless profile runs one task in the invoking directory, prints the final assistant response, and exits. It opens no browser and listens on no network port.

## Configure a credential

Export a [DeepSeek API key](https://platform.deepseek.com/) in the launching shell:

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
```

The [model configuration guide](./providers.md) covers other providers, custom OpenAI-compatible endpoints, and persistent settings.

## Choose a workspace

Change into an isolated project directory. The launcher uses that directory as the task's workspace:

```sh
cd /absolute/path/to/workspace
```

## Run a task

Run:

```sh
npx @deepseek-ai/dsh --profile headless "Summarize this repository and identify its main packages."
```

The profile creates one persisted session and waits for all work to settle before returning. Its configured tools may modify the workspace, so use a disposable checkout until you understand the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use profiles and plugin management](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/index.md)
