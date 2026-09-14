import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { materializeProfilePatch } from '../src/launcher.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('materializes a real installation dependency while preserving authored package precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-patch-'))
  roots.push(root)
  const authored = join(root, 'authored')
  const installation = join(root, 'installation')
  const output = join(root, 'output')
  for (const dir of [authored, installation, output]) mkdirSync(dir)
  const source = join(authored, 'cordis.yml')
  writeFileSync(source, '- insert:\n    - id: probe\n      name: probe-package\n')
  const installedPackage = join(installation, 'node_modules/probe-package')
  mkdirSync(installedPackage, { recursive: true })
  writeFileSync(join(installedPackage, 'package.json'), '{"name":"probe-package","version":"1.0.0"}')
  const first = join(root, 'first')
  const materialized = materializeProfilePatch(source, first, output, 0, join(installation, 'bin.js'))
  expect(realpathSync(join(first, '.dsh/profiles/node_modules/probe-package'))).toBe(realpathSync(installedPackage))
  expect(readFileSync(materialized, 'utf8')).toContain('name: probe-package')

  const authoredPackage = join(authored, 'node_modules/probe-package')
  mkdirSync(authoredPackage, { recursive: true })
  writeFileSync(join(authoredPackage, 'package.json'), '{"name":"probe-package","version":"2.0.0"}')
  const second = join(root, 'second')
  materializeProfilePatch(source, second, output, 1, join(installation, 'bin.js'))
  expect(realpathSync(join(second, '.dsh/profiles/node_modules/probe-package'))).toBe(realpathSync(authoredPackage))
})

it('keeps an unresolvable bare package authored when the launch has no installation anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-patch-'))
  roots.push(root)
  const authored = join(root, 'authored')
  const output = join(root, 'output')
  for (const dir of [authored, output]) mkdirSync(dir)
  const source = join(authored, 'cordis.yml')
  writeFileSync(source, '- insert:\n    - id: probe\n      name: probe-package\n')
  const cwd = join(root, 'cwd')
  const materialized = materializeProfilePatch(source, cwd, output, 0)
  // The package may belong to the dsh installation, which heals the link at
  // profile boot; the authored bare name survives and no fallback link appears.
  expect(readFileSync(materialized, 'utf8')).toContain('name: probe-package')
  expect(existsSync(join(cwd, '.dsh', 'profiles', 'node_modules'))).toBe(false)
})
