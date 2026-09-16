/** The Remote face delegates to the provider's discovery contract unchanged. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileReferenceService } from '../src/index.ts'
import type { FileReferenceCandidate } from '../src/types.ts'

describe('FileReferenceService', () => {
  it('serves the Remote face through the abstract discovery member', async () => {
    const candidates: FileReferenceCandidate[] = [{ path: 'src', kind: 'directory' }]
    const list = vi.fn((_agent: Agent, _query: string, _signal: AbortSignal) => Promise.resolve(candidates))
    class StubProvider extends FileReferenceService {
      list = list
    }
    const provider = new StubProvider(new Context())
    expect(provider.typertRemote.serviceKey).toBe('fileReferences')
    expect(provider.typertRemote.namespace).toBe('fileReferences')
    expect(remoteMethods(provider).map(method => method.exportName)).toEqual(['list'])
    const agent = { id: 'target' } as unknown as Agent
    const signal = new AbortController().signal
    await expect(provider.remoteExportList(agent, 'sr', signal)).resolves.toBe(candidates)
    expect(list).toHaveBeenCalledWith(agent, 'sr', signal)
  })

  it('preserves provider rejection and cancellation through the sole Remote owner', async () => {
    const rejected = new Error('fixture discovery failed')
    const list = vi.fn((_agent: Agent, _query: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      return Promise.reject(rejected)
    })
    class StubProvider extends FileReferenceService { list = list }
    const provider = new StubProvider(new Context())
    const agent = { id: 'target' } as unknown as Agent
    const signal = new AbortController().signal
    await expect(provider.remoteExportList(agent, 'src', signal)).rejects.toBe(rejected)
    const cancellation = new Error('fixture request cancelled')
    const aborted = AbortSignal.abort(cancellation)
    expect(() => provider.remoteExportList(agent, '', aborted)).toThrow(cancellation)
    expect(list).toHaveBeenLastCalledWith(agent, '', aborted)
  })

})
