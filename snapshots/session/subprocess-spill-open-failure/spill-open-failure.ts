import { mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

export const name = 'spill-open-failure'
export const inject = ['subprocess']

/** Remove only this scenario's private spill directory before output overflows. */
export function apply(ctx: Context): void {
  const subprocess = ctx.subprocess as LocalSubprocessRuntime
  const prior = subprocess.internals
  const spillDir = join(process.cwd(), '.dsh', 'unavailable-spill')
  mkdirSync(spillDir, { mode: 0o700 })
  rmdirSync(spillDir)
  subprocess.internals = { ...prior, spillDir }
  ctx.effect(() => () => { subprocess.internals = prior })

  const diagnostics: unknown[] = []
  ctx.logger.exporter({
    export(message) {
      if (typeof message.args[0] !== 'string' || !message.args[0].startsWith('subprocess-local:')) return
      const error = message.args[1] as NodeJS.ErrnoException
      diagnostics.push({
        type: message.type,
        message: message.args[0],
        code: error.code,
        syscall: error.syscall,
        path: error.path,
      })
      writeFileSync(join(process.cwd(), '.dsh', 'spill-diagnostics.json'), JSON.stringify(diagnostics))
    },
  })
}
