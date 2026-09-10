# Agent Note：备份、WebSocket 与迁移标记加固

Status: implemented

[English](2026-08-15-launch-scoped-security-hardening.md) | 中文

## 问题

三个启动级缺口都在运行中的构建上复现过。其一，`dsh-atomic-write` 的 `backupFile` 用 `copyFile` 直接把当前文档复制到 `<filename>.bak`，而 `copyFile` 会跟随预先埋好的符号链接：若 `.bak` 指向另一个文件，备份就会覆盖被指向的文件（设置与凭据都走这条路径）。其二，启动级 `DSH_API_TOKEN` 门禁只检查 HTTP 请求：不带 cookie 或 bearer 的 WebSocket 升级请求到 `/api/events.mux` 仍返回 101 Switching Protocols。其三，旧数据迁移在写入设置导入记录之前就写完成标记，记录写入冲突后标记仍在；下次启动报告「已迁移」，而导入记录仍然是错的。

## 决策

**`backupFile` 拒绝符号链接与非普通文件，并通过独占临时文件加 rename 提交。** 写前备份机制本身由[配置备份记录](2026-08-15-config-backup-and-redaction.zh.md)决定；本记录加固其提交路径。源文件以 `O_NOFOLLOW` 打开并按已打开 inode 判定（符号链接以 ELOOP 失败，目录无法通过普通文件检查），复制经由已打开的文件句柄完成，不存在先检查后使用的窗口。备份先写入独占创建（`wx`）的随机后缀兄弟文件，chmod、fsync 后再 rename 到 `.bak`——预先埋在 `.bak` 名字上的符号链接或硬链接会被全新 inode 替换，其指向的文件不受影响。回归测试在 `.bak` 名字上植入符号链接与硬链接、拒绝符号链接与非普通文件的源、并在并发写入方存在时运行并发备份。

**API 令牌门禁以与 HTTP 完全相同的方式约束 WebSocket 升级。** webserver 的升级路径在任何协议 handler 分发前执行同样的 `/api` bearer 或 SameSite cookie 检查；未认证的升级在原始 socket 上收到 HTTP 401。index 响应额外携带 Content-Security-Policy（仅同源资源、令牌 cookie 脚本以其 sha256 内容哈希准入——绝不使用 `unsafe-inline`——并放行回环 WebSocket），由 index 文档所有者通过新增的 `indexSecurityHeaders()` 附加；`dsh-host-frontend-static` 是该所有者，在每个 index 响应上应用它，并在服务时合并渲染正文中其他内联脚本（启动 manifest）的内容哈希，使动态客户端插件架构继续工作。

**迁移标记最后且原子地提交。** `migrateLegacyProductData` 仅在所有复制与设置导入记录都成功之后，以 `wx` 临时文件加 rename 的方式写入 `.ark-product-data-migration-v1` 标记；记录本身在每次尝试时原子重写，失败尝试留下的陈旧或残缺记录不会阻碍重试。标记路径上出现非普通文件视为冲突，而非「已迁移」。回归测试复现了原始故障（记录路径冲突），断言失败尝试后没有标记残留，并验证重试最终收敛。

## 备选方案

**在 `copyFile` 前 lstat 源与 `.bak`。** 否决：检查与复制是两个独立操作，存在 TOCTOU 窗口，且二者之间被换掉的 `.bak` 仍会被写穿。

**只在客户端或 connection 插件内强制令牌。** 否决：服务器才是执行点；路由 handler 不能依赖调用方的善意，且信任围栏不是认证层。

**先写标记、重试时修复记录。** 否决：两次写入之间发生崩溃或第二次失败仍会产生虚假的「已迁移」结果；只有最后提交标记的顺序才能让标记证明迁移完整。

## 影响

符号链接的设置或凭据源现在会大声失败而不是被读穿；此类布局的调用方需先解析链接。依赖令牌 cookie 的 WebSocket 客户端无需改动（cookie 在每个 index 响应上植入）；手工客户端必须发送 bearer。index CSP 按设计阻止异源子资源；基于哈希的脚本源让令牌植入 tap 在不用 `unsafe-inline` 的情况下继续工作。迁移重试收敛，而不再锁死在错误记录上。后续加固（[P0 批次 B](2026-08-16-p0-batch-b-sdk-web-pty.zh.md)）使门禁默认永不关闭：令牌依次取自配置 `apiToken`、`DSH_API_TOKEN`，否则每次启动随机铸造；`0.0.0.0` 绑定要求显式令牌。
