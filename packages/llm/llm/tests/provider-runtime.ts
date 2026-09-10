import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettings from '@deepseek-ai/dsh-settings-file'
import LlmRuntime, { LlmAdapter } from '../src/index.ts'
import type { GenerateOptions, StreamChunk } from '../src/index.ts'
import type { RemoteLlmProviderMutationRequest } from '../src/types.ts'

export const PROVIDER_TEST_NS = settingsNamespace('transaction-fixture')
export const PROVIDER_TEST_REF = credentialRef('ARK_SYNTHETIC_ALPHA')
export interface ProfileConfig {
  baseURL: string
  apiKeyEnv: string
  model: string
  apiKey?: string
  api?: string
  credentialHeaders?: Record<string, string>
  models?: Array<{ id: string; contextWindow: number }>
}
export interface Profiles { alpha: ProfileConfig; beta: ProfileConfig }
export const Profile: z<ProfileConfig> = z.object({
  baseURL: z.string(), apiKeyEnv: z.string(), model: z.string(), apiKey: z.string().role('secret'),
  api: z.string(), credentialHeaders: z.dict(z.string()),
  models: z.array(z.object({ id: z.string(), contextWindow: z.number() })),
})
const ProfilesSchema: z<Profiles> = z.object({ alpha: Profile, beta: Profile })

/** Only the external model transport is replaced; configuration owners execute normally. */
export class FixtureAdapter extends LlmAdapter {
  constructor(readonly profile: ProfileConfig) { super() }
  async* stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('configuration tests must not invoke a model') }
}

/** Boot the same Loader composition for unit, snapshot and fresh-process recovery checks. */
export async function createProviderRuntime(options: {
  root?: string
  namespace?: string
  baseAlpha?: ProfileConfig
  activation?: (next: Profiles) => Promise<void>
} = {}) {
  const namespace = settingsNamespace(options.namespace ?? PROVIDER_TEST_NS)
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'ark-provider-transaction-'))
  const settingsPath = join(root, 'settings.json')
  const credentialPath = join(root, 'credentials.yaml')
  const configPath = join(root, 'cordis.yml')
  const ctx = new Context()
  const dispose = async () => {
    await ctx.fiber.dispose()
    if (options.root === undefined) await rm(root, { recursive: true, force: true })
  }
  try {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    let active: Profiles | undefined
    const owner = {
      name: 'transaction-fixture-owner', inject: ['settings', 'credentials', 'llm'],
      apply(child: Context) {
        const scope = child.settings.register(namespace, ProfilesSchema, { base: {
          alpha: options.baseAlpha ?? { baseURL: 'https://alpha.invalid/v1', apiKeyEnv: PROVIDER_TEST_REF, model: 'initial' },
          beta: { baseURL: 'https://beta.invalid/v1', apiKeyEnv: 'ARK_SYNTHETIC_BETA', model: 'initial' },
        } })
        child.llm.registerConfigurableProviders(['alpha', 'beta'].map(provider => ({
          provider, displayName: provider, settingsNs: namespace, settingsPath: [provider], declared: true,
        })))
        let remove = child.llm.registerAdapter(['alpha'], new FixtureAdapter(scope.get().alpha))
        active = scope.get()
        scope.watch(async (next) => {
          await options.activation?.(next)
          remove()
          remove = child.llm.registerAdapter(['alpha'], new FixtureAdapter(next.alpha))
          active = next
        })
        child.effect(() => () => { remove() }, 'fixture.active-adapter')
      },
    }
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, 'fixture-settings': FileSettings,
      'fixture-credentials': LocalCredentials, 'fixture-llm': LlmRuntime, 'fixture-owner': owner })
    await writeFile(configPath, [
      '- id: settings', '  name: cordis:fixture-settings', '  config:', `    path: ${JSON.stringify(settingsPath)}`, '    watch: false',
      '- id: credentials', '  name: cordis:fixture-credentials', '  config:', `    path: ${JSON.stringify(credentialPath)}`, '    watch: false', '    mode: file',
      '- id: llm', '  name: cordis:fixture-llm', '- id: owner', '  name: cordis:fixture-owner', '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    if (active === undefined) throw new Error('provider fixture owner did not activate')
    const revision = () => ctx.settings.describe().find(entry => entry.ns === namespace)!.revision
    const request = (patch: Partial<RemoteLlmProviderMutationRequest> = {}): RemoteLlmProviderMutationRequest => ({
      transactionId: randomUUID(), provider: 'alpha', settingsNs: namespace, expectedRevision: revision(),
      ops: [{ op: 'set', path: ['alpha', 'model'], value: 'updated' }], ...patch,
    })
    const mutate = (value = request(), signal = new AbortController().signal) => ctx.llm.remoteMutateProvider(value, signal)
    return { ctx, root, namespace, settingsPath, credentialPath, revision, request, mutate,
      active: () => active!, close: () => ctx.fiber.dispose(), dispose }
  } catch (error) { await dispose(); throw error }
}
