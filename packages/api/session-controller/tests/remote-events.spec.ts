import { describe, expect, it } from 'vitest'
import { SESSION_CONTROLLER_REMOTE_EVENTS } from '../src/remote-events.ts'

describe('SESSION_CONTROLLER_REMOTE_EVENTS', () => {
  it('forwards the session controller event vocabulary unchanged through the Remote carrier', () => {
    expect(SESSION_CONTROLLER_REMOTE_EVENTS).toEqual([
      'api-session/activity',
      'api-session/added',
      'api-session/error',
      'api-session/removed',
      'api-session/status',
    ])
  })
})
