import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  environment: { DSH_TEST: 'native' },
  loadLayeredEnv: vi.fn(),
  runProfile: vi.fn(),
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadLayeredEnv: mocks.loadLayeredEnv,
}))

vi.mock('@deepseek-ai/dsh-profile-runner', () => ({
  runProfile: mocks.runProfile,
}))

import {
  ARK_NATIVE_API_INSTALL_ANCHOR,
  ARK_NATIVE_API_PROFILE,
  runNativeApi,
} from '../src/index.ts'

describe('Ark native API runner execution', () => {
  it('forwards one immutable jiuzhang invocation to the profile runner', async () => {
    mocks.loadLayeredEnv.mockReturnValue(mocks.environment)
    mocks.runProfile.mockResolvedValue(undefined)

    await runNativeApi(['--port', '0'])

    expect(mocks.loadLayeredEnv).toHaveBeenCalledOnce()
    expect(mocks.loadLayeredEnv).toHaveBeenCalledWith('dsh')
    expect(mocks.runProfile).toHaveBeenCalledOnce()
    expect(mocks.runProfile).toHaveBeenCalledWith({
      installAnchor: ARK_NATIVE_API_INSTALL_ANCHOR,
      environment: mocks.environment,
      profile: ARK_NATIVE_API_PROFILE,
      patchFiles: [],
      args: ['--port', '0'],
      watchLiveConfig: false,
      profilePatchMode: 'managed',
      homePatchMode: 'none',
    })
  })
})
