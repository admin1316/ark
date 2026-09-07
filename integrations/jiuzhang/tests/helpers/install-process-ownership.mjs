const childExited = child => child.exitCode !== null || child.signalCode !== null

const validIdentity = identity => (
  Number.isSafeInteger(identity?.pid) && identity.pid > 1
    && Number.isSafeInteger(identity.parentPid) && identity.parentPid >= 0
    && typeof identity.started === 'string' && identity.started !== ''
    && typeof identity.executable === 'string' && identity.executable.startsWith('/')
    && typeof identity.args === 'string' && identity.args !== ''
)

const sameIdentity = (left, right) => (
  validIdentity(left) && validIdentity(right)
    && left.pid === right.pid
    && left.started === right.started
    && left.executable === right.executable
    && left.args === right.args
)

const hasExactArgument = (identity, argument) => (
  identity.args.trim().split(/\s+/u).includes(argument)
)

export const parseInstallProcessTable = text => text.split('\n').flatMap(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/.exec(line)
  const args = match?.[4]
  return match === null ? [] : [{
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    started: match[3],
    executable: args.split(/\s+/u)[0],
    args,
  }]
})

export const retainedLauncherIsAlive = (rows, state) => {
  if (!validIdentity(state?.launcher)) return false
  return rows.some(process => sameIdentity(process, state.launcher))
}

export const retainedBackendIsAlive = (rows, state, backend) => {
  if (!validIdentity(state?.launcher) || !validIdentity(backend)
    || backend.parentPid !== state.launcher.pid) return false
  const currentBackend = rows.find(process => (
    sameIdentity(process, backend)
  ))
  if (currentBackend === undefined) return false
  if (currentBackend.parentPid === 1) return !retainedLauncherIsAlive(rows, state)
  if (currentBackend.parentPid !== state.launcher.pid) return false
  return retainedLauncherIsAlive(rows, state)
}

export const createInstallProcessOwnership = readProcessTable => {
  const states = new WeakMap()

  const capture = async (child, {
    launcherExecutable,
    launcherArgument,
    backendExecutable,
    backendArgument,
    listenerPids = [],
  } = {}) => {
    const retained = states.get(child)
    if (retained !== undefined) {
      if (retained.capturePromise !== undefined) return retained.capturePromise
      if (retained.captureError !== undefined) throw retained.captureError
      return retained
    }
    if (childExited(child)) return undefined
    const launcherPid = child.pid
    const state = {
      launcherPid,
      launcher: undefined,
      backends: [],
      listenerBackends: [],
      captureError: undefined,
      capturePromise: undefined,
      cleanupPromise: undefined,
      cleaned: false,
    }
    states.set(child, state)
    const pending = (async () => {
      try {
        if (!Number.isSafeInteger(launcherPid) || launcherPid <= 1) {
          throw new Error(`launcher handle did not expose a safe pid: ${String(launcherPid)}`)
        }
        const rows = await readProcessTable()
        const launcher = rows.find(process => process.pid === launcherPid)
        if (!validIdentity(launcher)) {
          throw new Error(`cannot capture launcher start identity for pid ${String(launcherPid)}`)
        }
        if (launcherExecutable !== undefined && launcher.executable !== launcherExecutable) {
          throw new Error(`launcher executable mismatch for pid ${String(launcherPid)}`)
        }
        if (launcherArgument !== undefined && !hasExactArgument(launcher, launcherArgument)) {
          throw new Error(`launcher argv mismatch for pid ${String(launcherPid)}`)
        }
        if (childExited(child)) throw new Error('launcher exited during ownership capture')
        const uniqueListenerPids = [...new Set(listenerPids)]
        if (!uniqueListenerPids.every(pid => Number.isSafeInteger(pid) && pid > 1)) {
          throw new Error('listener ownership contains an unsafe pid')
        }
        state.launcher = launcher
        state.backends = rows.filter(process => (
          process.parentPid === launcherPid && validIdentity(process)
        ))
        state.listenerBackends = uniqueListenerPids.map(pid => {
          const backend = state.backends.find(process => process.pid === pid)
          if (backend === undefined) {
            throw new Error(`listener pid ${String(pid)} is not a direct launcher child`)
          }
          if (backendExecutable !== undefined && backend.executable !== backendExecutable) {
            throw new Error(`listener executable mismatch for pid ${String(pid)}`)
          }
          if (backendArgument !== undefined && !hasExactArgument(backend, backendArgument)) {
            throw new Error(`listener argv mismatch for pid ${String(pid)}`)
          }
          return backend
        })
        return state
      } catch (error) {
        state.captureError = error
        throw error
      }
    })()
    state.capturePromise = pending
    return pending
  }

  const cleanup = (child, run) => {
    const state = states.get(child)
    if (state?.cleanupPromise !== undefined) return state.cleanupPromise
    if (state === undefined && childExited(child)) return Promise.resolve()
    const pending = Promise.resolve().then(() => run(state)).finally(() => {
      if (state !== undefined) state.cleaned = true
    })
    if (state !== undefined) state.cleanupPromise = pending
    return pending
  }

  return { capture, cleanup, get: child => states.get(child) }
}
