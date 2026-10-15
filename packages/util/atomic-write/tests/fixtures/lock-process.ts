import { open, readFile, rm } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '../../src/index.ts'

interface Request {
  target: string
  mode: 'hold' | 'increment'
  waitMs: number
}

process.once('message', (request: Request) => {
  void withFileLock(request.target, async () => {
    if (request.mode === 'hold') {
      process.send?.({ type: 'held' })
      await new Promise<void>((resolve) => { process.once('message', () => { resolve() }) })
      return
    }
    // Exclusive work marker catches overlapping entrants independently of the
    // final counter, including a lost-update race that happened to cancel out.
    const marker = `${request.target}.active`
    const handle = await open(marker, 'wx')
    try {
      const count = Number(await readFile(request.target, 'utf8'))
      await new Promise(resolve => setTimeout(resolve, 15))
      await writeFileAtomic(request.target, String(count + 1), { mode: 0o600 })
    } finally {
      await handle.close()
      await rm(marker)
    }
  }, { waitMs: request.waitMs }).then(() => {
    process.send?.({ type: 'done' }, () => { process.disconnect() })
  }, (error: unknown) => {
    process.exitCode = 1
    process.send?.({ type: 'error', message: String(error) }, () => { process.disconnect() })
  })
})
process.send?.({ type: 'ready' })
