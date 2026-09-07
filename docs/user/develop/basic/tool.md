# Build a tool

English | [中文](tool.zh.md)

This tutorial adds a model-facing `greet` tool to the headless profile. Complete [Your first plugin](./index.md) first and keep its `scratch-plugin` directory.

## Create the tool plugin

Replace `scratch-plugin/src/my-plugin.ts` with:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

`inject` makes Cordis wait for the tool registry. `defineTool` infers and validates `args` from `parameters`; `execute` returns the canonical value declared by `output.schema`, and `output.render` converts that value to model-facing content.

## Run and call the tool

Run a task that requests the tool:

```sh
pnpm dsh --profile headless --patch ./scratch-plugin/cordis.yml "Use the greet tool to greet Ada."
```

The model can call `greet`, receives `Hello, Ada!` as the tool result, and the command prints its final response.

## Next steps

- [Plugin configuration](./config.md) — make the greeting configurable.
- [Tool authoring reference](../../../cookbook/adding-a-tool.md) — look up nested schemas, canonical values, background work, policy hooks, and Code Mode.
- [Capability layering](../practice/index.md) — split a replaceable capability into Service Definition, Service Provider, and Consumer packages.
