# 参与贡献

[English](CONTRIBUTING.md) | 中文

感谢你为 Ark 贡献力量。

这是 Ark 的私有产品仓库，包含产品层（集成、启动器、macOS 应用包装、契约测试）以及它所构建的框架本体。

## 参与方式

- 直接向产品团队报告问题与改进建议。
- 新增或扩展契约测试：每个产品面都有对应测试，可用 `pnpm run test:jiuzhang` 运行。
- 完善产品文档与工程说明。

## 开发

- 构建、验证、打包与布局细节：[工程说明](integrations/jiuzhang/docs/engineering.md)。
- 提交信息遵循 Conventional Commits；本地 pre-commit 与 pre-push 钩子会运行相关检查。
- 在本仓库工作的 agent 遵循 [AGENTS.md](AGENTS.md)。

## 许可证

本仓库以 MIT 许可证发布——见 [LICENSE](LICENSE)。第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
