# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Read the [safety boundaries](SAFETY.md) before enabling tools or opening an untrusted workspace.

## Run

### Run from `npm`

Install `Node.js`, set a DeepSeek credential, then run one headless task:

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
npx @deepseek-ai/dsh --profile headless "Summarize this repository"
```

The command creates one persisted session, prints the final answer, and exits without opening a browser or listening on a port. See the [headless quickstart](docs/user/guide/index.md); automation clients can instead use the [Python SDK](docs/user/guide/python-sdk.md) or ACP examples.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
export DEEPSEEK_API_KEY=sk-your-key-here
pnpm dsh --profile headless "Summarize this repository"
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
