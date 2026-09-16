import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each([
  { compile: 0, reflection: 0, bundle: 0 },
  { compile: 1, reflection: 0, bundle: 0 },
  { compile: 0, reflection: 7, bundle: 0 },
  { compile: 0, reflection: 0, bundle: 9 },
])('serializes and preserves stage failures: %j', async (status) => {
  const root = await mkdtemp(join(tmpdir(), 'ark-build-order-'))
  try {
    for (const directory of ['scripts', 'node_modules/typescript/bin', 'node_modules/tsdown/dist', 'packages/example/lib']) {
      await mkdir(join(root, directory), { recursive: true })
    }
    await writeFile(join(root, 'scripts/build-host-bundles.mjs'), await readFile(
      new URL('./build-host-bundles.ts', import.meta.url), 'utf8',
    ))
    await reflectionFixture(root, status.reflection)
    await writeFile(join(root, 'packages/example/lib/index.js'), 'existing artifact')
    await writeFile(join(root, 'node_modules/typescript/bin/tsc'),
      `require('node:fs').appendFileSync('order.txt', 'compile\\n'); process.exit(${status.compile})`,
    )
    await writeFile(join(root, 'node_modules/tsdown/dist/run.mjs'),
      `import { appendFileSync } from 'node:fs'; appendFileSync('order.txt', 'bundle\\n'); process.exit(${status.bundle})`,
    )
    const run = execute(process.execPath, [join(root, 'scripts/build-host-bundles.mjs')], { cwd: root })
    const failure = status.compile || status.reflection || status.bundle
    if (failure === 0) await expect(run).resolves.toMatchObject({ stderr: '' })
    else await expect(run).rejects.toMatchObject({ code: failure })
    expect(await readFile(join(root, 'order.txt'), 'utf8')).toBe(status.compile !== 0
      ? 'compile\n'
      : status.reflection !== 0 ? 'compile\nreflection\n' : 'compile\nreflection\nbundle\n')
    expect(await readFile(join(root, 'packages/example/lib/index.js'), 'utf8')).toBe('existing artifact')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('uses real TypeScript build options with invalid source %s', async (invalid) => {
  const root = await mkdtemp(join(tmpdir(), 'ark-real-build-order-'))
  try {
    for (const directory of ['scripts', 'node_modules/tsdown/dist', 'lib']) {
      await mkdir(join(root, directory), { recursive: true })
    }
    await symlink(fileURLToPath(new URL('../node_modules/typescript', import.meta.url)),
      join(root, 'node_modules/typescript'), 'dir')
    await writeFile(join(root, 'scripts/build-host-bundles.mjs'), await readFile(
      new URL('./build-host-bundles.ts', import.meta.url), 'utf8',
    ))
    await reflectionFixture(root, 0)
    const base = await readFile(new URL('../tsconfig.base.json', import.meta.url), 'utf8')
    expect(base).toContain('"noEmitOnError": true')
    await writeFile(join(root, 'tsconfig.host.json'), JSON.stringify({
      compilerOptions: { composite: true, noEmitOnError: true, outDir: 'lib', types: [] },
      files: ['index.ts'],
    }))
    await writeFile(join(root, 'index.ts'), invalid ? 'const value: string = 1;' : 'const value: string = "ok";')
    await writeFile(join(root, 'lib/index.js'), 'existing artifact')
    await writeFile(join(root, 'node_modules/tsdown/dist/run.mjs'),
      'console.log("bundle reached")')
    const run = execute(process.execPath, [join(root, 'scripts/build-host-bundles.mjs')], { cwd: root })
    if (invalid) {
      await expect(run).rejects.toHaveProperty('stdout', expect.stringContaining('error TS2322'))
      expect(await readFile(join(root, 'lib/index.js'), 'utf8')).toBe('existing artifact')
    } else {
      await expect(run).resolves.toHaveProperty('stdout', expect.stringContaining('bundle reached'))
      expect(await readFile(join(root, 'lib/index.js'), 'utf8')).toContain('"ok"')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function reflectionFixture(root: string, status: number): Promise<void> {
  const directory = join(root, 'packages/typert/generator/lib/types')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await writeFile(join(directory, 'tsdown-plugin.js'), `
    import { appendFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    export function emitVerifiedWorkspaceArtifacts(root, faces) {
      assert.equal(root, process.cwd());
      assert.deepEqual(faces, ['host']);
      appendFileSync('order.txt', 'reflection\\n');
      process.exit(${status});
    }
  `)
}
