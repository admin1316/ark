---
description: "原子文件替换与跨进程写锁，供绝不允许在磁盘上留下不完整、被符号链接劫持或权限过宽内容的包使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-atomic-write

[English](README.md) | 中文

## 概述

`dsh-atomic-write` 一步原子地替换文件内容：目标的读取方总是看到完整的旧内容或完整的新内容，绝不看到部分写入。它还通过写锁跨进程串行化读-渲染-提交循环，因此同一文件的并发写入方无法复活彼此替换掉的状态。调用方为每次替换声明权限位，全新 inode 会带着这些权限位走完交换，因此替换权限过宽的旧文件时会直接收窄，不存在 chmod 竞态。它是一个零依赖库，由用户设置文档与凭据存储这类文件型存储共享；`cordis.yml` 无法加载它，而且由于没有 `fsync`，崩溃持久性由调用方负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当文件型存储必须替换一份已渲染好的字符串、且绝不允许暴露部分写入、符号链接劫持或权限过宽状态时，使用 `writeFileAtomic`；当多个进程读写同一文件时，使用 `withFileLock`。最小路径是一次调用，传入最终内容与替换 inode 的权限位。

### 原子写入文件

```ts
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })
```

父目录会按需创建，读取方只会观察到旧内容或完整的新内容。只有本次调用独占创建成功的临时文件才会进入清理：创建被拒时绝不移除其他写入者的文件。后续失败会尝试关闭并移除本次拥有的临时文件，再重新抛出原始错误，目标文件保持不变。清理本身失败时，该临时文件可能保留，供后续检查。

### 协调写入方

对于单靠原子提交无法保证安全的读-渲染-提交循环，请在操作期间持有写锁：

```text
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const render: (previous: string) => string
declare const readCurrent: () => Promise<string>

await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  const previous = await readCurrent()
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(previous), { mode: 0o600 })
})
```

只有写入方会竞争——读取方从不取锁——竞争者按指数退避，超时即以错误失败，而不是无限阻塞。竞争者等待多久由每次调用经 `waitMs` 声明：默认值只按纯文件工作量级选定，因此持锁方循环若包含一次网络往返——例如刷新过期 token 的凭据变更——就应声明更长的值，否则该文件的其他写入方在这段时间内都会失败。退避节奏保持固定。只有完整 PID 记录对应的进程探测明确返回 `ESRCH`，竞争者才能接管锁；文件存续时间不能作为归属证据。

### 需要规划的失败

锁的父目录必须已经存在，因此 `withFileLock` 会在运行操作之前拒绝无效的父目录层级。持锁进程退出时会留下可由后续写入方接管的锁文件。存活持有者、其他用户的持有者（`EPERM`）、竞争者自身 PID 和不完整记录都继续受到保护。若接管认领文件遗留，竞争者仍会超时；操作者必须核实两个持有者后才能恢复这一特殊状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包建立在一个分离之上：原子提交负责交换，写锁负责跨进程排序。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `writeFileAtomic` 与 `withFileLock`，即本包的全部接口 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；替换约定由单元测试覆盖） |

### 写入路径

`writeFileAtomic` 先以独占创建（`wx`）打开一个随机后缀的同级文件并写入内容，然后 rename 到目标上。独占打开拒绝跟随预先埋在可猜测临时路径上的符号链接；同目录兄弟文件保证 rename 落在同一文件系统上；rename 替换的是符号链接目标本身，绝不写穿到其指向的文件。

`withFileLock` 以 `wx` 创建 `<filename>.lock` 同级文件。`EEXIST` 直接表示竞争；只有一次新的 `lstat` 确认锁路径存在时，`EPERM` 才表示竞争，从而兼容 Windows 的独占创建行为，又不掩盖无关的权限故障。Windows 对无法确认锁存在的一次 `EPERM` 进行重试，以覆盖独占创建与存在探测之间持有者恰好释放锁的情况；重复权限错误仍抛出。锁保留可互操作的 `<pid>\n` 记录。竞争者接管已退出持有者时，先通过按记录命名的认领文件串行化，再次读取记录并探测 PID 后才移除旧锁。持有者在 `finally` 中核对持有时的文件身份与记录后释放锁。竞争按指数退避，在每次调用声明的 `waitMs` 期限（默认两秒）过后失败。

### 交换为何安全

- **全新 inode，调用方声明的权限位**——临时文件带着 `mode` 走完 rename，因此收窄权限过宽的文件没有 chmod 竞态。`mode` 为必填，让权限决策始终可见于每个调用点。
- **读取方从不竞争**——rename 提交是原子的，读取方无需加锁。
- **接管必须证明进程退出**——只有 `ESRCH` 允许接管，且认领后再次核对记录和 PID。暂停但仍存活的写入方继续受到保护。
- **释放时保留已观察到的替换件**——不同 inode 或 PID 记录不会被移除。核对与 unlink 是分开的文件系统操作，不能提供对外部干扰的原子比较删除。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要了解消费它的存储或本原语所属的家族时，阅读以下页面。

- [用户设置文件存储](../../settings/settings-file/README.zh.md)——每次写入都通过本包替换的设置文档。
- [凭据存储](../../credentials/credentials-local/README.zh.md)——本包加锁并替换的凭据文件。
- [util 组映射](../README.zh.md)——本包所属的零依赖工具家族。

-----

<a id="model-experience"></a>
## 模型体验

无：本包是纯文件系统写入原语，不注册任何面向模型的内容。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不是合适的工具。它们是当前包约束，不是任务积压。

- **原子但不保证持久**——不对文件或其所在目录做 `fsync`，因此崩溃后可能观察到 rename 被回退。此处的文件型存储在启动时重新读取并重新发布，把持久性留作调用方的策略。
- **仅支持字符串内容**——在有消费方需要之前，不提供 `Buffer` 或流式形态。
- **部分遗留状态仍需操作者恢复**——不完整记录、被存活进程复用的 PID，以及旧锁移除前遗留的认领文件仍会阻塞。竞争者绝不移除已有认领文件。
- **限同一主机和 PID 命名空间**——不支持跨主机或跨 PID 命名空间共享文件。接管只证明持锁进程退出，不能证明子写入进程退出；启动此类进程的调用方负责其生命周期。
- **协作写入方边界**——身份核对会保留释放前观察到的替换件，但无法阻止最终核对与 unlink 之间任意外部替换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

一种对文件及其父目录执行 `fsync`、并在 Windows 上保留仅属主权限的持久性替换方案仍未实现（在源码中记录为 `settings-atomic-durability`）。

</details>
