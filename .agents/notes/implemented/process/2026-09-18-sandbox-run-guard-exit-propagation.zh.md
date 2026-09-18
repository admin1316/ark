# Agent Note: Sandbox run-guard 的退出码传播

Status: implemented

[English](2026-09-18-sandbox-run-guard-exit-propagation.md) | 中文

## 问题

[sandbox.yml](../../../../.github/workflows/sandbox.yml) 中的两个 e2e 步骤用一段 shell 包装器包住 vitest 运行，其目的是在平台文件实际未运行时让步骤失败。包装器有意关闭了 errexit，以便命令失败时仍能输出捕获的日志，但这也移除了唯一的自动传播：

```bash
set -u +e -o pipefail
out=$(pnpm exec vitest run ... 2>&1); status=$?
echo "$out"
[ "$status" -eq 0 ]
echo "$out" | grep -qE 'Test Files[[:space:]]+2 passed \(2\)'
```

裸测试求值为非零状态，随后继续执行汇总 grep，而步骤状态由后者决定。因此，当 vitest 退出码非零、但输出仍匹配证据正则时（例如通过汇总之后的未处理错误，或任何被正则接受的汇总行），步骤会报告绿色，而测试命令其实已经失败。检查存在，但只是"可写"，并不"绑定"。

## 决策

两处包装器都显式传播，并且在任何检查之前仍然打印捕获的输出，因此不重写日志、也不伪造通过文本：

```bash
if [ "$status" -ne 0 ]; then
  echo "sandbox e2e exited with status $status" >&2
  exit "$status"
fi
if ! echo "$out" | grep -qE 'Test Files[[:space:]]+2 passed \(2\)'; then
  echo "sandbox e2e did not report 'Test Files  2 passed (2)'" >&2
  exit 1
fi
```

测试命令非零时立即以原始状态失败退出；测试命令为零但缺少必需执行证据时以退出码 1 失败并指出缺失的证据。打包分发步骤使用同样的结构与其 `1 passed (1)` 要求。门禁本身不变：两个平台文件必须真正运行，自我跳过仍然失败。

[scripts/sandbox-workflow-guard.spec.ts](../../../../scripts/sandbox-workflow-guard.spec.ts)执行的是真实包装器而非副本：它从 workflow 中提取每个命名步骤的 `run` 块，在 `bash` 下用会产出受控状态与输出的 stub `pnpm` 运行。覆盖：通过状态且证据齐全、状态 7 且证据看似完整、零状态但证据缺失或全跳过、非零状态且证据缺失。

## 备选方案

**依赖最后一条命令的状态。** 这正是缺陷本身：errexit 关闭时，最后执行的命令决定步骤状态，末尾成功的 grep 会静默替换失败的测试命令。

**用 `set -e` 恢复 errexit。** 捕获输出正是为失败情形准备的，errexit 会在命令替换处中止、来不及发布该诊断；显式检查既保留诊断，又让传播无条件成立。

**把包装器抽成仓库内的 shell 脚本。** 独立脚本更易测试，但它会在同一次改动里重构步骤结构及其证据契约；提取式 spec 直接运行生产文本，因此在不动契约的前提下覆盖了复制漂移风险。

## 后果

失败的测试命令不再可能被匹配的汇总行覆盖：步骤以测试自身的状态退出，工作流记录真实失败。

执行证据缺失或自我跳过仍会让步骤失败，现在会显式指出缺失的必需汇总，因此丢失隔离能力的 runner 不能作为绿色腿通过。

回归 spec 运行 workflow 文本本身，因此今后对任一包装器的改动都会被同样四类用例检验；它不改变任何历史 CI 结论，也不声称过去的绿色步骤是假的。
