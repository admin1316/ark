/** Native Swift consumer to generated Host descriptor coverage. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_LEGACY_API_ENDPOINTS,
  NATIVE_TYPERT_REMOTE_ENDPOINTS,
  NATIVE_TYPERT_REMOTE_OWNERS,
} from '../src/native-remote-routes.ts'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))

const swiftConsumers = [
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkAPIClient.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkArchiveAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkManagementAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkFeedbackAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkDomainAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkComposerAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkInteractionAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkPluginSettingsAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkSettingsAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkSubagentAPI.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkAppModel.swift',
  'integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkGoalModels.swift',
] as const

const descriptorFiles = [
  'packages/preset/agent-presets/lib/typert.host.js',
  'packages/interaction/commands/lib/typert.host.js',
  'packages/credentials/credentials/lib/typert.host.js',
  'packages/context/file-reference/lib/typert.host.js',
  'packages/context/session-reference/lib/typert.host.js',
  'packages/goal/goal/lib/typert.host.js',
  'packages/host/knowledge-wiki/lib/typert.host.js',
  'packages/llm/llm/lib/typert.host.js',
  'packages/feedback/message-feedback/lib/typert.host.js',
  'packages/host/plugin-inventory/lib/typert.host.js',
  'packages/core/session/lib/typert.host.js',
  'packages/settings/settings/lib/typert.host.js',
  'packages/skill/skill/lib/typert.host.js',
  'packages/subagent/subagent/lib/typert.host.js',
  'packages/host/workbench/lib/typert.host.js',
  'packages/workspace/workspace/lib/typert.host.js',
] as const

function slashRoutes(source: string): string[] {
  const routes = new Set<string>()
  for (const match of source.matchAll(/public\s+static\s+let\s+\w+\s*=\s*"([A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*)"/gu)) {
    routes.add(match[1] as string)
  }
  const remoteCall = /remote(?:Domain)?(?:Call|Request)\(\s*method:\s*"([A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*)"/gsu
  for (const match of source.matchAll(remoteCall)) {
    routes.add(match[1] as string)
  }
  return [...routes]
}

function legacyDotCalls(source: string): string[] {
  return [...source.matchAll(/\bcall\(\s*method:\s*"([A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)"/gsu)]
    .map(match => match[1] as string)
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

describe('Native Typert Remote route coverage', () => {
  it('matches every Swift Method constant and explicit strict Remote helper call', async () => {
    const texts = await Promise.all(swiftConsumers.map(path => readFile(`${repositoryRoot}/${path}`, 'utf8')))
    const fromSwift = [...new Set(texts.flatMap(slashRoutes))].sort()
    expect([...NATIVE_TYPERT_REMOTE_ENDPOINTS].sort()).toEqual(fromSwift)
    expect(new Set(NATIVE_TYPERT_REMOTE_ENDPOINTS).size).toBe(NATIVE_TYPERT_REMOTE_ENDPOINTS.length)
  })

  it('maps every Native route to exactly one generated Host descriptor owner', async () => {
    const descriptorText = await Promise.all(descriptorFiles.map(path => readFile(`${repositoryRoot}/${path}`, 'utf8')))
    for (const endpoint of NATIVE_TYPERT_REMOTE_ENDPOINTS) {
      const matches = descriptorText.flatMap((text) => {
        const match = new RegExp(
          `id: '[^']+#${escaped(endpoint)}',\\s+service: '([^']+)'`,
          'su',
        ).exec(text)
        return match === null ? [] : [match[1] as string]
      })
      expect(matches).toEqual([NATIVE_TYPERT_REMOTE_OWNERS[endpoint]])
    }
  })

  it('keeps the remaining API-only dot route explicit and closed to growth', async () => {
    const texts = await Promise.all(swiftConsumers.map(path => readFile(`${repositoryRoot}/${path}`, 'utf8')))
    const fromSwift = [...new Set(texts.flatMap(legacyDotCalls))].sort()
    expect([...NATIVE_LEGACY_API_ENDPOINTS].sort()).toEqual(fromSwift)
  })

  it('keeps Native Review as the sole Git owner', async () => {
    const [host, domain, descriptor] = await Promise.all([
      readFile(`${repositoryRoot}/packages/host/workbench/src/index.ts`, 'utf8'),
      readFile(
        `${repositoryRoot}/integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkDomainAPI.swift`,
        'utf8',
      ),
      readFile(`${repositoryRoot}/packages/host/workbench/lib/typert.host.js`, 'utf8'),
    ])
    expect(NATIVE_TYPERT_REMOTE_ENDPOINTS).not.toContain('workbench/gitStatus')
    expect(NATIVE_TYPERT_REMOTE_ENDPOINTS).not.toContain('workbench/gitDiff')
    expect(host).not.toContain("@Remote('gitStatus')")
    expect(host).not.toContain("@Remote('gitDiff')")
    expect(domain).not.toContain('workbench/gitStatus')
    expect(domain).not.toContain('workbench/gitDiff')
    expect(descriptor).not.toContain('workbench/gitStatus')
    expect(descriptor).not.toContain('workbench/gitDiff')
  })

  it('keeps NativeWorkspaceAccess as the sole Files tree and read owner', async () => {
    const [host, domain, appModel, workbench, descriptor] = await Promise.all([
      readFile(`${repositoryRoot}/packages/host/workbench/src/index.ts`, 'utf8'),
      readFile(
        `${repositoryRoot}/integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkDomainAPI.swift`,
        'utf8',
      ),
      readFile(
        `${repositoryRoot}/integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkAppModel.swift`,
        'utf8',
      ),
      readFile(
        `${repositoryRoot}/integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeWorkbenchView.swift`,
        'utf8',
      ),
      readFile(`${repositoryRoot}/packages/host/workbench/lib/typert.host.js`, 'utf8'),
    ])
    for (const route of ['workbench/tree', 'workbench/read']) {
      expect(NATIVE_TYPERT_REMOTE_ENDPOINTS).not.toContain(route)
      expect(domain).not.toContain(route)
      expect(descriptor).not.toContain(route)
    }
    expect(host).not.toContain("@Remote('tree')")
    expect(host).not.toContain("@Remote('read')")
    expect(appModel).not.toContain('func workbenchTree(')
    expect(appModel).not.toContain('func workbenchFile(')
    expect(workbench).not.toContain('appModel.workbenchTree(')
    expect(workbench).not.toContain('appModel.workbenchFile(')
    expect(workbench).toContain('Task.detached(priority: .userInitiated)')
    expect(workbench).toContain('NativeWorkspaceAccess(rootURL: rootURL)')
  })
})
