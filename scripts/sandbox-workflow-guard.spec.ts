import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflowPath = join(import.meta.dirname, '..', '.github', 'workflows', 'sandbox.yml')
const runnerExpression = '$' + '{{ matrix.runner }}'

/**
 * Extract the real 'run' block of one workflow step, so the regression executes
 * the production guard rather than a copy of it.
 * @param stepName - exact step name in sandbox.yml.
 * @param runner - value replacing the matrix expression.
 * @returns the shell script the workflow would run.
 */
function workflowRunScript(stepName: string, runner: string): string {
  const lines = readFileSync(workflowPath, 'utf8').split('\n')
  const stepIndex = lines.findIndex(line => line.trim() === `- name: ${stepName}`)
  if (stepIndex < 0) throw new Error(`missing step: ${stepName}`)
  const runIndex = lines.findIndex((line, index) => index > stepIndex && /^\s+run: \|$/u.test(line))
  if (runIndex < 0) throw new Error(`missing run block: ${stepName}`)
  const indent = ((lines[runIndex] ?? '').match(/^\s*/u)?.[0].length ?? 0) + 2
  const body: string[] = []
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) {
      body.push('')
      continue
    }
    if ((line.match(/^\s*/u)?.[0].length ?? 0) < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n').replaceAll(runnerExpression, runner)
}

interface GuardResult {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Run the extracted guard with a stub pnpm that produces exactly one controlled
 * test outcome, so every branch of the guard is reached deterministically.
 */
function runGuard(stepName: string, runner: string, testStatus: number, output: string): GuardResult {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sandbox-guard-'))
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    const stub = join(bin, 'pnpm')
    writeFileSync(stub, '#!/bin/bash\nprintf \'%s\\n\' "$FAKE_OUTPUT"\nexit "$FAKE_STATUS"\n')
    chmodSync(stub, 0o755)
    const scriptPath = join(directory, 'guard.sh')
    writeFileSync(scriptPath, workflowRunScript(stepName, runner))
    const result = spawnSync('bash', [scriptPath], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_STATUS: String(testStatus),
        FAKE_OUTPUT: output,
      },
      encoding: 'utf8',
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const SANDBOX_STEP = 'Sandbox e2e (real kernel confinement, world-verified)'
const PACKED_STEP = 'Packed-distribution e2e (pack → install → confine)'
const sandboxEvidence = ' Test Files  2 passed (2)'
const packedEvidence = ' Test Files  1 passed (1)'

// The wrappers run on ubuntu and macos runners only; Windows has no bash here.
describe.skipIf(process.platform === 'win32')('sandbox workflow run guards', () => {
  it('passes when the tests pass and the required execution evidence is present', () => {
    const sandbox = runGuard(SANDBOX_STEP, 'seatbelt', 0, `ok\n${sandboxEvidence}\n`)
    expect(sandbox.status).toBe(0)
    const packed = runGuard(PACKED_STEP, 'landlock', 0, `ok\n${packedEvidence}\n`)
    expect(packed.status).toBe(0)
  })

  it('fails with the test status even when the summary text looks complete', () => {
    // This is the defect the guard previously had: a non-zero test status was
    // overwritten by the trailing summary grep.
    const sandbox = runGuard(SANDBOX_STEP, 'seatbelt', 7, `ok\n${sandboxEvidence}\n`)
    expect(sandbox.status).toBe(7)
    expect(sandbox.stderr).toContain('sandbox e2e exited with status 7')
    const packed = runGuard(PACKED_STEP, 'landlock', 7, `ok\n${packedEvidence}\n`)
    expect(packed.status).toBe(7)
    expect(packed.stderr).toContain('packed-distribution e2e exited with status 7')
  })

  it('fails when a passing status carries no required execution evidence', () => {
    const skipped = runGuard(SANDBOX_STEP, 'seatbelt', 0, ' Test Files  2 skipped (2)\n')
    expect(skipped.status).toBe(1)
    expect(skipped.stderr).toContain("did not report 'Test Files  2 passed (2)'")
    const empty = runGuard(PACKED_STEP, 'landlock', 0, 'no summary here\n')
    expect(empty.status).toBe(1)
  })

  it('fails when the tests fail and the execution evidence is missing too', () => {
    const sandbox = runGuard(SANDBOX_STEP, 'seatbelt', 5, 'cancelled\n')
    expect(sandbox.status).toBe(5)
    const packed = runGuard(PACKED_STEP, 'landlock', 3, 'cancelled\n')
    expect(packed.status).toBe(3)
  })
})
