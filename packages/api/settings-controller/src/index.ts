/**
 * Host desktop actions supplementing the canonical settings and credentials
 * Remote owners on their storage Services.
 * @module @deepseek-ai/dsh-api-settings-controller
 */

import { dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  InvalidPresetIdError,
  PresetExistsError,
  PresetNotWritableError,
  UnknownPresetError,
} from '@deepseek-ai/dsh-agent-presets'
import {
  canOpenNativePath,
  openNativePath,
} from '@deepseek-ai/dsh-native-command'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPresetDirectoryOpenValue, SettingsDocumentOpenValue } from './types.ts'

export type * from './types.ts'

/** Native document-opening policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
}

/** Host integrations replaceable by direct unit tests. */
export interface SettingsControllerInternals {
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  readonly canOpenPath?: () => boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host desktop actions in the `settings` Remote namespace. */
    settingsController: SettingsController
  }
}

/** Host desktop actions; settings reads and writes belong to SettingsProvider. */
export class SettingsController extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({ nativeOpen: Schema.boolean() })

  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean

  /** Mount desktop actions alongside the provider-owned Remote namespace. */
  constructor(ctx: Context, config: Config = {}, internals: SettingsControllerInternals = {}) {
    super(ctx, 'settingsController', { namespace: 'settings' })
    this.openPath = internals.openPath ?? openNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
  }

  /**
   * Report whether this deployment can open an authored Agent preset directory natively.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenAgentPresetDirectory(): boolean {
    return this.canOpenPath()
  }

  /**
   * Materialize the provider-owned settings document and open it in a native text editor.
   * @param signal - caller lifetime; abort terminates preparation or the native command.
   * @returns confirmation after the native opener accepts the document.
   * @throws TypertRemoteFailure when no document exists, preparation fails, or opening fails.
   */
  @Remote
  async openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue> {
    return this.provider().remoteOpenDocument(signal)
  }

  /**
   * Open one user-authored Agent preset directory or return its path when no native opener exists.
   * @param agentPreset - preset id resolved against Host-owned roots.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns an opened confirmation or the resolved directory for text display.
   * @throws TypertRemoteFailure when the preset is missing, read-only, invalid, or cannot be opened.
   */
  @Remote
  async openAgentPresetDirectory(
    agentPreset: string,
    signal: AbortSignal,
  ): Promise<AgentPresetDirectoryOpenValue> {
    if (agentPreset.length === 0) {
      throw new TypertRemoteFailure({
        code: 'bad-request', message: 'agent preset id must not be empty', details: {},
      })
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      throw new TypertRemoteFailure({
        code: 'agent-preset-not-found',
        message: 'this deployment composes no agent presets',
        details: { agentPreset, available: [] },
      })
    }
    let directory: string
    try {
      const preset = await presets.resolve(agentPreset)
      if (preset.trust !== 'user') {
        throw new PresetNotWritableError(preset.id, 'it ships with the deployment')
      }
      directory = dirname(preset.path)
    } catch (error: unknown) {
      throw presetFailure(agentPreset, error)
    }
    if (!this.canOpenPath()) return { opened: false, path: directory }
    try {
      await this.openPath(directory, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw cancelled('path open was aborted')
      throw internal(`path open failed: ${messageOf(error)}`)
    }
  }

  /** Resolve the optional provider or report how to supply it. */
  private provider(): SettingsProvider {
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new TypertRemoteFailure({
        code: 'internal',
        message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition',
        details: {},
      })
    }
    return settings
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function internal(message: string): TypertRemoteFailure {
  return new TypertRemoteFailure({ code: 'internal', message, details: {} })
}

function cancelled(message: string): TypertRemoteFailure {
  return new TypertRemoteFailure({ code: 'cancelled', message, details: {} })
}

function presetFailure(agentPreset: string, error: unknown): TypertRemoteFailure {
  if (error instanceof UnknownPresetError) {
    return new TypertRemoteFailure({
      code: 'agent-preset-not-found',
      message: error.message,
      details: { agentPreset: error.presetId, available: [...error.available] },
    })
  }
  if (error instanceof PresetNotWritableError) {
    return new TypertRemoteFailure({
      code: 'agent-preset-read-only',
      message: error.message,
      details: { agentPreset, reason: error.message },
    })
  }
  if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) {
    return new TypertRemoteFailure({
      code: 'agent-preset-invalid',
      message: error.message,
      details: { agentPreset, reason: error.message },
    })
  }
  if (error instanceof TypertRemoteFailure) return error
  return internal(`agent preset "${agentPreset}": ${String(error)}`)
}

export default SettingsController
