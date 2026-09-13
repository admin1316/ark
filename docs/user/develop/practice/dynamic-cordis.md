# Extend a running agent with Cordis tools

English | [中文](dynamic-cordis.zh.md)

This practice guide enables [`@deepseek-ai/dsh-tool-cordis`](../../../../packages/extensions/tool-cordis/README.md). The agent can inspect its current Cordis process and mount or unmount model-authored plugins in memory. Temporary plugins disappear when they are unmounted or the process exits and may affect other sessions in the same process.

## Run it

Configure an installed [custom CLI profile](../../../../apps/cli/README.md#profiles) with a live Agent, model credentials, `@deepseek-ai/dsh-cordis-host-runner`, and `@deepseek-ai/dsh-tool-cordis`. Declare the packages in that profile's dependencies and mount them in its `cordis.patch.yml` before starting the profile. The browser-specific example overlay is not an Ark Native startup command.

The [Cordis tool reference](../../../../packages/extensions/tool-cordis/README.md) defines tool arguments, lifetime, cleanup, and safety contracts. After the profile starts, ask the Agent to inspect its loaded Cordis services and verify the tool result before requesting a temporary plugin.
