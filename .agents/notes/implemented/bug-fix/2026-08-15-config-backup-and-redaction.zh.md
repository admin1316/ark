# Agent Note：配置写前备份与线边界密钥加固

Status: implemented

[English](2026-08-15-config-backup-and-redaction.md) | 中文

## 问题

排查一次线上「DeepSeek API 请求失败」事件时暴露了两个安全缺口。其一，`settings.yaml` 与 `.credentials.yaml` 被外部程序改写（单行 flow 风格，`gpt-5.6` 提供方及其 key 被删除），全程没有任何写前快照，此前状态只能从 shell 历史找回，产品自身无法恢复。其二，设置脱敏 walker 自己的注释和包 README 都记录了一个 fail-closed 缺口：只能通过 union、intersect 或 transform 节点到达的 `role('secret')` 字段会被原样返回；同时 API 代理的会话搜索错误路径把整个错误对象（`String(error)`）序列化进了面向客户端的信息。

## 决策

**每次设置与凭据写入都保留写前备份。** `dsh-atomic-write` 新增 `backupFile`：把当前文档复制为 `<filename>.bak`（0600，源缺失时为空操作），并在持有写锁期间、替换提交之前调用；`dsh-settings-file`（persistSection）与 `dsh-credentials-local`（write）都在此调用。备份始终反映最近一次已提交状态；恢复该兄弟文件即可回滚一次错误写入或外部编辑。

**脱敏 walker 对未证明安全的容器 fail closed。** `redactSecrets` 的 default 分支现在先探测 schema 子树（`dict`/`inner`/`list`）中是否存在任何 secret 角色字段，再决定是否放行值；仅能通过 union、intersect 或 transform 节点到达的 secret 会抛错而非泄露，错误信息携带字段路径。union/intersect 的分支 schema 通过节点的 `list` 关系访问，`SchemaNode` 现已声明该字段。

**API 代理错误路径只发送错误自身的 message。** 会话搜索失败不再把 `String(error)` 序列化进线消息；改为发送 `error.message`（或字符串化兜底），完整对象留在服务端。

## 备选方案

**就地监视并回滚外部编辑。** 否决：watcher 无法区分恶意改写与合法的手工编辑，自动回滚会与用户对抗。写前备份保留操作者自由，同时让每一个先前状态都可恢复。

**在脱敏时完整解析 union/intersect/transform。** 否决：schemastery 的解析依赖具体值，而剥离场景下 walker 没有可用于解析的值；子树探测（任何 secret 可达即 fail closed）才是健全的边界。剩余未证明表面——`schema.toJSON()` 携带 secret 字段的 `.default(...)`——继续留在 README Known Limitations 中。

## 结果

117 个包测试（atomic-write、credentials-local、settings-file）加 158 个 settings 测试加 383 个 api-proxy 测试全部通过；新分支自带测试（备份内容/权限/空操作/重抛；union/intersect/transform/根级 fail-closed；无 secret 的 union 放行）。`jiuzhang-runtime` 与 Ark harness profile 中的运行时副本已重建，并以一次端到端凭据写入验证产生了正确的 0600 `.bak`。同一 api-proxy 文件中的在途 session-archive 改动与之共存并通过。
