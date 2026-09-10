# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for contributing to Ark.

This is the private product repository for Ark. It contains the product layer (integration, launchers, macOS wrapper, contract tests) together with the framework it builds on.

## Ways to contribute

- Report bugs and suggest improvements to the product team directly.
- Add or extend contract tests: every product surface ships tests, runnable with `pnpm run test:jiuzhang`.
- Improve the product documentation and the engineering notes.

## Development

- Build, verification, packaging, and layout details: [engineering documentation](integrations/jiuzhang/docs/engineering.md).
- Commit messages follow Conventional Commits; local pre-commit and pre-push hooks run the relevant checks.
- Agents working in this repository follow [AGENTS.md](AGENTS.md).

## License

The repository is MIT licensed — see [LICENSE](LICENSE). Third-party licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
