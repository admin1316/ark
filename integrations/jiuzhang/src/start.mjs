#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  assertStandaloneRuntimeClosure,
  createLaunchEnvironment,
  installRuntimeConfiguration,
  ensureProfileModuleFallback,
  purgeReservedJiuzhangPreset,
  legacyJiuzhangHome,
  migrateLegacyProductData,
  readSettingsImportRecord,
  resolveBuiltArkNativeRunner,
  resolveLaunchHome,
  resolveSessionWorkingDirectory,
  seedLocalModelProvider,
} from './runtime.mjs'

// Launcher-owned arguments are parsed before any potentially blocking runtime
// preparation so parent identity monitoring protects the whole startup window.
const forwardedArgs = []
let parentPid = null
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (arg === '--parent-pid') {
    const value = process.argv[index + 1]
    if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 1) {
      throw new Error('Invalid --parent-pid')
    }
    parentPid = Number(value)
    index += 1
    continue
  }
  forwardedArgs.push(arg)
}

const home = resolveLaunchHome(process.env, { native: parentPid !== null })

const CHILD_GRACE_MS = 6_000
const PARENT_POLL_MS = 100
let child = null
let childKillDeadline = null
let parentWatch = null
let shuttingDown = false
let shutdownExitCode = 0

const stopParentWatch = () => {
  if (parentWatch === null) return
  clearInterval(parentWatch)
  parentWatch = null
}

const parentIdentityIsCurrent = () => {
  if (parentPid === null) return true
  if (process.ppid !== parentPid) return false
  try {
    process.kill(parentPid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

// Parent death and launcher signals converge here. Before spawn, immediate
// launcher exit prevents a late backend from appearing after its UI owner has
// gone. After spawn, only the retained ChildProcess is signalled, and it gets
// the profile runner's full five-second disposal window plus one second of
// supervisor margin before escalation.
const shutdownOnce = (signal = 'SIGTERM', exitCode = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  shutdownExitCode = exitCode
  stopParentWatch()
  if (child === null) {
    process.exit(exitCode)
    return
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal)
    childKillDeadline = setTimeout(() => {
      if (child?.exitCode === null && child.signalCode === null) {
        if (shutdownExitCode === 0) shutdownExitCode = 1
        console.error(`Ark backend did not stop within ${String(CHILD_GRACE_MS)}ms; forcing owned child exit`)
        child.kill('SIGKILL')
      }
    }, CHILD_GRACE_MS)
    childKillDeadline.unref()
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdownOnce(signal, signal === 'SIGINT' ? 130 : 0))
}

const observeParent = () => {
  if (!parentIdentityIsCurrent()) shutdownOnce()
}

if (parentPid !== null) {
  parentWatch = setInterval(observeParent, PARENT_POLL_MS)
  parentWatch.unref()
  observeParent()
}

const recheckParent = () => {
  if (parentIdentityIsCurrent()) return
  shutdownOnce()
}

await assertStandaloneRuntimeClosure()
recheckParent()
if (!process.env.JIUZHANG_DSH_HOME) {
  try {
    await migrateLegacyProductData(legacyJiuzhangHome(), home)
    recheckParent()
  } catch (error) {
    console.error(`Ark 数据迁移失败：${error?.message ?? error}`)
    process.exit(1)
  }
  const imported = await readSettingsImportRecord(home)
  if (imported !== undefined) {
    console.warn(
      'Ark 已从旧版本导入设置：默认 Agent = '
      + `${imported.agentPresetDefault ?? '未设置'}，权限 = ${imported.permissionPresetDefault ?? '未设置'}。`
      + '旧值已保留（见 .ark-settings-import.json）；可在设置中改回 Ark 安全默认（Ark 预设 + 只读）。',
    )
  }
}
await installRuntimeConfiguration(home)
recheckParent()
// 保留 ID 清理：preset service 暴露前删除历史 jiuzhang 目录（幂等）。
await purgeReservedJiuzhangPreset(home)
recheckParent()
await ensureProfileModuleFallback(home)
recheckParent()
// Opt-in: set ARK_SEED_OLLAMA=1 to seed the ready-to-use local provider.
if (process.env.ARK_SEED_OLLAMA === '1') {
  await seedLocalModelProvider(home)
  recheckParent()
}

// 测试钩子：JIUZHANG_LAUNCHER_CHILD 以 dummy child 替换 built CLI（生产不设置）。
const testChild = process.env.JIUZHANG_LAUNCHER_CHILD
const childArgs = testChild === undefined
  ? [
      await resolveBuiltArkNativeRunner(),
      ...forwardedArgs,
    ]
  : [
      testChild,
      ...forwardedArgs,
    ]
const childWorkingDirectory = await resolveSessionWorkingDirectory()
recheckParent()
child = spawn(process.execPath, childArgs, {
  cwd: childWorkingDirectory,
  env: createLaunchEnvironment(home),
  stdio: 'inherit',
})

child.once('error', error => {
  stopParentWatch()
  console.error(`九章天幕启动失败：${error.message}`)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  stopParentWatch()
  if (childKillDeadline !== null) clearTimeout(childKillDeadline)
  if (!shuttingDown) {
    process.exitCode = signal === null ? (code ?? 1) : 1
    return
  }
  if (signal === 'SIGKILL') {
    process.exitCode = shutdownExitCode === 0 ? 1 : shutdownExitCode
  } else if (code !== null && code !== 0) {
    process.exitCode = code
  } else {
    process.exitCode = shutdownExitCode
  }
})

// Close the final race between the pre-spawn identity check and spawn itself.
recheckParent()
