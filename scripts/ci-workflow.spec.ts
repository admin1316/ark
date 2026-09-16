import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination =
  /^\$\{\{ runner\.temp \}\}\/setup-pnpm-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.job \}\}$/
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}'

describe('CI workflow', () => {
  it('gives the Linux coverage lane the extended gate timeout budget', () => {
    // The Linux coverage lane runs instrumented plus heavy subprocess fixtures.
    // Vitest's default 5 s per-test budget is not enough for scripts/oxlint-contract.spec.ts
    // under gate contention (it timed out at 5000 ms on this runner and locally),
    // so the job must keep supplying the budget run-gates already knows how to apply.
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const coverage = workflowJob(workflow, 'node-24-coverage')
    expect(coverage.env).toMatchObject({
      DSH_COVERAGE_MAX_WORKERS: '2',
      DSH_COVERAGE_PARTITIONS: '4',
      DSH_GATE_CONCURRENCY: '2',
      DSH_COVERAGE_TEST_TIMEOUT_MS: '30000',
    })
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/ci-master.yml']
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      const stepDest = (step as { with?: { dest?: unknown } }).with?.dest
      if (jobName.startsWith('windows-')) {
        expect(stepDest, `${jobName} must use the native Windows pnpm destination`).toBe(nativeWindowsPnpmDestination)
        expect(step).not.toMatchObject({ with: { standalone: true } })
      } else {
        expect(typeof stepDest, `${jobName} must use a runner-and-run-private pnpm destination`).toBe('string')
        expect(stepDest as string).toMatch(runnerPrivatePnpmDestination)
      }
    }
  })

  it('isolates the python SDK exe pnpm setup destination per job', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('build-exe-for-python-sdk.yml must define jobs')
    const setups: Array<{ step: unknown }> = []
    for (const job of Object.values(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue
      for (const step of job.steps) {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
        setups.push({ step })
      }
    }
    expect(setups.length).toBeGreaterThan(0)
    for (const { step } of setups) {
      expect(step).toMatchObject({
        with: { dest: nativeWindowsPnpmDestination },
      })
    }
  })

  it('builds the host lib outputs before the static and coverage consumers run', () => {
    // The lib outputs are no longer tracked: the static and coverage lanes must
    // build them after install (and re-link the workspace bins) before any
    // consumer gate reads them, or knip and the plugin-loading specs fail on a
    // clean checkout.
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('ci.yml must define jobs')
    for (const jobName of ['node-24', 'node-24-coverage']) {
      const job = workflow.jobs[jobName]
      if (!isRecord(job) || !Array.isArray(job.steps)) throw new TypeError(jobName + ' must define steps')
      const runs = job.steps.map(step => (isRecord(step) && typeof step.run === 'string' ? step.run : ''))
      const buildIndex = runs.findIndex(run => run === 'pnpm run build:lib:host')
      const relinkIndex = runs.findIndex(run => run === 'pnpm install --frozen-lockfile --offline')
      const consumerIndexes = runs.reduce<Array<number>>((acc, run, index) => {
        if (run.includes('check:ci:static') || run.includes('check:ci:coverage')) acc.push(index)
        return acc
      }, [])
      expect(buildIndex, jobName + ' must build the host lib outputs').toBeGreaterThan(-1)
      expect(relinkIndex, jobName + ' must re-link workspace bins after the build').toBeGreaterThan(buildIndex)
      expect(consumerIndexes.length, jobName + ' must run its consumers').toBeGreaterThan(0)
      for (const index of consumerIndexes) {
        expect(index, jobName + ' consumers must run after the build and re-link').toBeGreaterThan(relinkIndex)
      }
    }
  })

  it('keeps required hosted Linux, Wine and macOS checks plus complete native Windows reporting', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const master = loadWorkflow('.github/workflows/ci-master.yml')
    const windows = workflowJob(workflow, 'windows')
    const native = workflowJob(workflow, 'windows-native')
    const macos = workflowJob(workflow, 'macos-native')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    expect(windows).toMatchObject({ 'runs-on': 'ubuntu-latest', if: "github.event_name == 'pull_request'" })
    expect(JSON.stringify(windows.steps)).toContain('bash scripts/wine-windows-gates.sh')
    expect(native).toMatchObject({ 'runs-on': 'windows-2025', if: "github.event_name == 'pull_request'" })
    if (!Array.isArray(native.steps)) throw new TypeError('native Windows must define steps')
    expect(native.steps.filter(isRecord).find(step => step.name === 'Run complete native Windows gate inventory')).toMatchObject({
      shell: 'pwsh', run: 'pnpm run check:ci:windows-complete',
    })
    expect(macos).toMatchObject({ 'runs-on': 'macos-15', if: "github.event_name == 'pull_request'" })
    expect(JSON.stringify(macos.steps)).toContain('--product JiuzhangShellContractTests')
    expect(JSON.stringify(macos.steps)).toContain('.build/debug/JiuzhangShellContractTests')
    for (const name of ['node-24', 'node-24-coverage', 'node-24-consumers', 'all-checks-passed']) {
      expect(workflowJob(workflow, name)['runs-on'], name).toBe('ubuntu-24.04')
    }
    expect(aggregate.needs).toEqual([
      'node-24', 'node-24-coverage', 'node-24-consumers', 'node-compat',
      'python-sdk', 'python-runtime', 'windows', 'macos-native',
    ])
    expect(aggregate.if).toContain('always()')
    const verdict = JSON.stringify(aggregate.steps)
    for (const result of ['failure', 'cancelled', 'skipped']) expect(verdict).toContain(`'${result}'`)
    expect(verdict).toContain('exit 1')
    expect(workflowJob(master, 'wine-apt-cache')).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/main'", 'runs-on': 'ubuntu-latest',
    })
    expect(workflowJob(master, 'serial-windows')).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/main'", 'runs-on': 'windows-2025',
    })
  })

  it('gives the Wine Host TypeScript compile the repository heap budget', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    expect(wineGates).toContain(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=4096 "$tsc_js" -b tsconfig.host.json --pretty false',
    )
  })

  it('exempts push from cancellation in ci-master, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('ci-master workflow must define jobs and a workflow-level concurrency block')
    }
    if (!isRecord(prWorkflow.jobs)) {
      throw new TypeError('ci workflow must define jobs')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // The PR-only ci.yml still cancels a superseded run on a new push, so a
    // fresh head does not stack a second full 9-job run behind a stale one.
    // Unlike ci-master it has no push carve-out: every PR event supersedes.
    expect(prWorkflow.concurrency).toMatchObject({
      'cancel-in-progress': true,
    })

    // The exact event sets are what keep master-only jobs out of the PR check
    // panel: ci-master triggers only on push(master) + workflow_dispatch and
    // never on pull_request; ci.yml is exactly pull_request-only. Assert the
    // full sets so losing the wrong event, or gaining an extra one, fails.
    if (!isRecord(workflow.on) || !isRecord(prWorkflow.on)) {
      throw new TypeError('both CI workflows must define on')
    }
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(Object.keys(prWorkflow.on)).toEqual(['pull_request'])

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only; that is what makes the push carve-out safe.
      expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'")
    }

    // What bounds the cost of exempting push: a master push may only carry the
    // cache seeder and the two drills. Any job reachable on push would start
    // accumulating uncancelled runs, so the set is pinned here.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted', 'serial-windows', 'wine-apt-cache'])

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires release-shaped Python runtime validation on every published target', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python runtime / release-shaped matrix',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-win-x64',
        ci: true,
      },
      secrets: {
        DEEPSEEK_API_KEY_EXTERNAL: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('DeepSeek e2e workflow', () => {
  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })

  it('bounds profile subprocess fan-out to the tested e2e default', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const step = e2e.steps.filter(isRecord).find(candidate => candidate.name === 'E2E tests (real DeepSeek API)')
    expect(step).toMatchObject({ env: { DSH_E2E_MAX_WORKERS: 4 } })
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and gates the focused live suite on the optional secret', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    const job = workflowJob(workflow, 'e2b')
    if (!Array.isArray(job.steps)) throw new TypeError('E2B e2e workflow must define the e2b job steps')

    const steps = job.steps.filter(isRecord)
    const gate = steps.find(step => step.name === 'Gate optional E2B_API_KEY')
    const build = steps.find(step => step.name === 'Build (lib for the E2B Loader smoke)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    // The optional secret is what makes this live suite opt-in: one gate reports
    // presence, and both the build and the live suite run only when it reported
    // the secret. A missing secret therefore produces a neutral skip, never a red
    // run, and never an unconditional skip either.
    expect(gate).toMatchObject({
      id: 'e2b-secret',
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(gate?.run).toBe('bash scripts/ci-secret-gate.sh E2B_API_KEY')
    expect(build?.if).toBe("steps.e2b-secret.outputs.enabled == 'true'")
    expect(e2b?.if).toBe("steps.e2b-secret.outputs.enabled == 'true'")
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')

    // A genuine build or live-suite failure must still fail the job: no step opts
    // out of failure and none swallows one.
    for (const step of steps) {
      expect(step['continue-on-error']).toBeUndefined()
      expect(stepText(step.run)).not.toContain('|| true')
    }

    // Gate behaviour, executed for real. GitHub passes an unconfigured secret as an
    // empty environment value, which is the shape pinned here.
    const absent = runSecretGate('bash scripts/ci-secret-gate.sh E2B_API_KEY', { E2B_API_KEY: '' })
    expect(absent.status).toBe(0)
    expect(absent.output).toContain('enabled=false')
    expect(absent.stdout).toContain('E2B_API_KEY')
    expect(absent.stdout).not.toContain('value')

    const sentinel = 'e2b-secret-sentinel'
    const present = runSecretGate('bash scripts/ci-secret-gate.sh E2B_API_KEY', { E2B_API_KEY: sentinel })
    expect(present.status).toBe(0)
    expect(present.output).toContain('enabled=true')
    expect(present.stdout).not.toContain(sentinel)
    expect(present.stderr).not.toContain(sentinel)
  })
})

describe('Python release workflows', () => {
  it('executes release file-set admission for all five artifacts and rejects a missing Windows wheel', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const validate = workflowJob(workflow, 'validate')
    if (!Array.isArray(validate.steps)) throw new TypeError('release validation must have steps')
    const step = validate.steps.filter(isRecord).find(value => value.name === 'Check release contents')
    if (typeof step?.run !== 'string') throw new TypeError('release contents check must be executable shell')
    // Exercise the exact set comparison. The later Linux stat loop is covered by runner validation.
    const comparison = step.run.split('while IFS=')[0]
    if (comparison === undefined || !comparison.includes('diff -u')) throw new TypeError('release set comparison is missing')
    const platforms = JSON.parse(readFileSync(join(root, 'python/sdk-runtime/platforms.json'), 'utf8')) as Record<
      string, { tag: string }
    >
    const fixture = mkdtempSync(join(tmpdir(), 'ci-release-set-'))
    try {
      mkdirSync(join(fixture, 'dist'))
      const version = '1.2.3rc1'
      writeFileSync(join(fixture, `dist/deepseek_harness_sdk-${version}-py3-none-any.whl`), 'filename fixture')
      for (const platform of Object.values(platforms)) {
        writeFileSync(join(fixture, `dist/deepseek_harness_runtime_bin-${version}-py3-none-${platform.tag}.whl`), 'filename fixture')
      }
      const run = (): ReturnType<typeof spawnSync> => spawnSync('bash', ['-c', comparison], {
        cwd: fixture, encoding: 'utf8', env: { ...process.env, VERSION: version, TMPDIR: fixture },
      })
      const complete = run()
      expect(complete.status, String(complete.stderr)).toBe(0)
      rmSync(join(fixture, `dist/deepseek_harness_runtime_bin-${version}-py3-none-win_amd64.whl`))
      expect(run().status).not.toBe(0)
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it('gives the single-exe build the repository host heap budget', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const build = workflowJob(workflow, 'build')
    if (!Array.isArray(build.steps)) throw new TypeError('build job must have steps')
    const step = build.steps.filter(isRecord).find(value => value.name === 'Build single-exe')
    // Step-scoped on purpose: only this build inherits the 4096 MB budget the Wine
    // lane already pins; install, smoke and release steps keep the default.
    expect(step?.env).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096' })
  })

  it('executes the target planner for all published carriers and rejects unsupported targets', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const plan = workflowJob(workflow, 'plan')
    if (!Array.isArray(plan.steps)) throw new TypeError('target plan must have steps')
    const step = plan.steps.filter(isRecord).find(value => value.name === 'Compute matrix from targets input')
    if (typeof step?.run !== 'string') throw new TypeError('target planner must be executable shell')
    const fixture = mkdtempSync(join(tmpdir(), 'ci-target-plan-'))
    const output = join(fixture, 'output')
    try {
      const result = spawnSync('bash', ['-c', step.run], {
        cwd: fixture, encoding: 'utf8',
        env: { ...process.env, TARGETS: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-win-x64', GITHUB_OUTPUT: output },
      })
      expect(result.status, result.stderr).toBe(0)
      const rows = JSON.parse(readFileSync(output, 'utf8').trim().slice('matrix='.length)) as Array<{ target: string; runner: string }>
      const platforms = JSON.parse(readFileSync(join(root, 'python/sdk-runtime/platforms.json'), 'utf8')) as Record<string, unknown>
      expect(rows.map(row => row.target.replace('node24-', '')).sort()).toEqual(Object.keys(platforms).sort())
      expect(rows.find(row => row.target === 'node24-win-x64')?.runner).toBe('windows-2025')
      expect(rows.find(row => row.target === 'node24-macos-arm64')?.runner).toBe('macos-15')
      const rejected = spawnSync('bash', ['-c', step.run], {
        cwd: fixture, encoding: 'utf8', env: { ...process.env, TARGETS: 'node24-win-arm64', GITHUB_OUTPUT: output },
      })
      expect(rejected.status).toBe(1)
      expect(rejected.stdout).toContain('Unknown target')
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it('executes artifact-name resolution against the platform owner and rejects missing payloads', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const build = workflowJob(workflow, 'build')
    if (!Array.isArray(build.steps)) throw new TypeError('native build must have steps')
    const step = build.steps.filter(isRecord).find(value => value.name === 'Resolve platform outputs')
    if (typeof step?.run !== 'string') throw new TypeError('platform resolver must be executable Python')
    expect(step.shell).toBe('python')
    const platforms = JSON.parse(readFileSync(join(root, 'python/sdk-runtime/platforms.json'), 'utf8')) as Record<
      string, { executable: string; tag: string }
    >
    const fixture = mkdtempSync(join(tmpdir(), 'ci-artifact-name-'))
    try {
      mkdirSync(join(fixture, 'python/sdk-runtime'), { recursive: true })
      mkdirSync(join(fixture, 'dist-exe'))
      writeFileSync(join(fixture, 'python/sdk-runtime/platforms.json'), JSON.stringify(platforms))
      for (const [platform, spec] of Object.entries(platforms)) {
        // This tests name admission, not execution of a native runtime or a wheel.
        const payload = join(fixture, 'dist-exe', spec.executable)
        writeFileSync(payload, 'artifact-name fixture')
        chmodSync(payload, 0o755)
        const output = join(fixture, `${platform}.output`)
        const env = { ...process.env, TARGET: `node24-${platform}`, VERSION: '1.2.3rc1', GITHUB_OUTPUT: output }
        const result = spawnSync('python3', ['-c', step.run], { cwd: fixture, encoding: 'utf8', env })
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(output, 'utf8')).toContain(`wheel=deepseek_harness_runtime_bin-1.2.3rc1-py3-none-${spec.tag}.whl`)
        expect(readFileSync(output, 'utf8')).toContain(`exe=${realpathSync(payload)}`)
        rmSync(payload)
        const missing = spawnSync('python3', ['-c', step.run], { cwd: fixture, encoding: 'utf8', env })
        expect(missing.status).not.toBe(0)
        expect(missing.stderr).toContain('missing or non-executable runtime')
      }
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    if (!isRecord(workflow.on)) throw new TypeError('python-release workflow must define on')
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'workflow_dispatch'])
    expect(workflowEvent(workflow, 'pull_request')).toMatchObject({ types: ['labeled'] })
    expect(build).toMatchObject({
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-win-x64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(Object.keys(workflow.on as Record<string, unknown>).sort()).toEqual(['pull_request', 'workflow_call', 'workflow_dispatch'])
    expect(workflowEvent(workflow, 'pull_request')).toMatchObject({ types: ['labeled'] })
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !isRecord(call.secrets) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    if (!isRecord(manylinuxSmoke)) throw new TypeError('Python wheel builder must define the manylinux container smoke')
    const cleanVenvPosix = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (POSIX)')
    const cleanVenvWindows = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (Windows)')
    const installedKeylessPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (POSIX)')
    const installedKeylessWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (Windows)')
    const apiSecretGate = buildSteps.find(step => isRecord(step) && step.name === 'Gate optional real-API secret')
    const installedRealApiPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (POSIX)')
    const installedRealApiWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (Windows)')
    if (!isRecord(cleanVenvPosix) || !isRecord(cleanVenvWindows)
      || !isRecord(installedKeylessPosix) || !isRecord(installedKeylessWindows)
      || !isRecord(apiSecretGate)
      || !isRecord(installedRealApiPosix) || !isRecord(installedRealApiWindows)) {
      throw new TypeError('Python wheel builder must define native POSIX and Windows installed-wheel steps')
    }
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(call.secrets).toMatchObject({
      DEEPSEEK_API_KEY_EXTERNAL: { required: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(build.defaults).toBeUndefined()
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('python/sdk-runtime/platforms.json')
    const outputStep = buildSteps.find(step => isRecord(step) && step.name === 'Resolve platform outputs')
    expect(isRecord(outputStep) && String(outputStep.run)).toContain('spec["executable"]')
    expect(workflowJson).toContain('node24-win-x64')
    expect(workflowJson).toContain('windows-2025')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(workflowJson).not.toContain('cygpath')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('pnpm_setup_root')
    expect(JSON.stringify(manylinuxAddon)).toContain('$pnpm_setup_root:$pnpm_setup_root:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(JSON.stringify(installedKeylessPosix)).toContain('--scenario all')
    expect(JSON.stringify(installedKeylessPosix)).toContain('env -u PYTHONPATH')
    expect(JSON.stringify(installedKeylessWindows)).toContain('--scenario all --installed-wheel')
    expect(installedKeylessWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(cleanVenvWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(String(cleanVenvWindows.run)).toContain('Scripts/python.exe')
    // The live-API test is gated on the optional secret: an unconfigured
    // secret skips it instead of failing the required runtime leg, and the
    // keyless black-box above stays unconditional.
    expect(apiSecretGate).toMatchObject({
      id: 'api-secret',
      shell: 'bash',
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(String(apiSecretGate.run)).toBe('bash scripts/ci-secret-gate.sh DEEPSEEK_API_KEY')
    expect(String(installedRealApiPosix.if)).toContain("steps.api-secret.outputs.enabled == 'true'")
    expect(String(installedRealApiWindows.if)).toContain("steps.api-secret.outputs.enabled == 'true'")
    expect(String(installedKeylessPosix.if)).toBe("runner.os != 'Windows'")
    expect(String(installedKeylessWindows.if)).toBe("runner.os == 'Windows'")
    expect(installedRealApiPosix).toMatchObject({
      env: {
        DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      },
    })
    expect(JSON.stringify(installedRealApiPosix)).toContain('--scenario sdk-live')
    expect(JSON.stringify(installedRealApiPosix)).toContain('-u DSH_RUNTIME_MODE')
    expect(installedRealApiWindows).toMatchObject({ shell: 'pwsh' })
    expect(JSON.stringify(installedRealApiWindows)).toContain('--scenario sdk-live --installed-wheel')
    expect(workflow.on).not.toHaveProperty('pull_request_target')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    for (const secretStep of [apiSecretGate]) {
      expect(String(secretStep.if)).toContain('inputs.ci')
      expect(String(secretStep.if)).toContain("github.event_name == 'pull_request'")
      expect(String(secretStep.if)).toContain('!github.event.pull_request.head.repo.fork')
      expect(String(secretStep.if)).toContain("github.event.pull_request.user.login != 'dependabot[bot]'")
    }
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    // The pnpm-backed out-of-tree-plugin scenario runs inside the container
    // too, so the runner's Node and pnpm toolchain is shared read-only at
    // identical paths and prepended to the container's PATH.
    expect(String(manylinuxSmoke.run)).toContain('PATH_EXTRA="$node_root/bin:$PNPM_HOME"')
    // The pnpm shim resolves its JavaScript from the setup root, so that root —
    // not just PNPM_HOME — is what gets mounted into the container.
    const linuxPnpmSetupRoot = '${{ runner.temp }}/setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}'
    expect(String(manylinuxSmoke.run)).toContain(`pnpm_setup_root="${linuxPnpmSetupRoot}"`)
    expect(String(manylinuxSmoke.run)).toContain('-v "$pnpm_setup_root:$pnpm_setup_root:ro"')
    expect(String(manylinuxSmoke.run)).toContain('pnpm --version')
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(windows.before_script.join('\n')).toContain('.ci-python/Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Issue lifecycle workflow', () => {
  it('keeps the trusted-policy boundary and a bootstrap-safe optional gate', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    if (!Array.isArray(lifecycleJob.steps)) throw new TypeError('Issue lifecycle job must define steps')

    // The job has no job-level `if`, so it is listed on every pull_request /
    // pull_request_review event and reports success instead of a gray skip. The
    // write-capable steps are gated at step level so approved/commented reviews
    // never mint a Project/Issue App token nor touch the board.
    expect(lifecycle.on).toHaveProperty('pull_request')
    expect(lifecycle.on).toHaveProperty('pull_request_review')
    expect(lifecycleJob.if).toBeUndefined()
    // Keep the subscription-type gates: issue-lifecycle does not re-subscribe
    // ready_for_review (issue-policy owns that) and only reacts to submitted
    // review events.
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])

    const steps = lifecycleJob.steps.filter(isRecord)
    const checkoutIndex = steps.findIndex(step => stepText(step.uses).startsWith('actions/checkout@'))
    const gateIndex = steps.findIndex(step => step.name === 'Gate optional Project automation')
    const tokenStep = steps.find(s => s.name === 'Create project token')
    const handleStep = steps.find(s => s.name === 'Handle repository event')

    // The policy that judges a run comes from the TRUSTED default branch, never from
    // the pull request being judged, and the gate runs after that checkout.
    expect(checkoutIndex).toBeGreaterThanOrEqual(0)
    expect(steps[checkoutIndex]).toMatchObject({
      with: { ref: '${{ github.event.repository.default_branch }}' },
    })
    expect(gateIndex).toBeGreaterThan(checkoutIndex)

    // Bootstrap safety: the gate body is inline because a helper introduced on a
    // pull-request branch is absent from the trusted tree this job just checked out,
    // and depending on it failed every event with exit 127.
    const gateRun = stepText(steps[gateIndex]?.run)
    expect(gateRun).not.toContain('scripts/ci-secret-gate.sh')
    expect(gateRun).toContain('enabled=false')
    expect(gateRun).toContain('GITHUB_OUTPUT')

    // Unconfigured optional automation: the write-capable steps skip, and the job
    // does not fail merely because the App is not installed on this repository.
    const enabled = "steps.app-config.outputs.enabled == 'true'"
    const reviewOnly = "github.event_name != 'pull_request_review' || github.event.review.state == 'changes_requested'"
    const expectedIf = '${{ ' + enabled + ' && (' + reviewOnly + ') }}'
    expect(tokenStep).toMatchObject({ if: expectedIf })
    expect(handleStep).toMatchObject({ if: expectedIf })

    // A configured App still targets THIS repository and never the upstream one.
    expect(tokenStep).toMatchObject({
      with: {
        'client-id': '${{ vars.DSH_ISSUE_APP_CLIENT_ID }}',
        'private-key': '${{ secrets.DSH_ISSUE_APP_PRIVATE_KEY }}',
        owner: '${{ github.repository_owner }}',
        repositories: '${{ github.event.repository.name }}',
      },
    })
    expect(JSON.stringify(lifecycle)).not.toContain('deepseek-harness')

    // A real board mutation failure must still fail the job.
    for (const step of steps) {
      expect(step['continue-on-error']).toBeUndefined()
      expect(stepText(step.run)).not.toContain('|| true')
    }

    // Gate behaviour, executed for real: an empty environment value is what GitHub
    // passes for an unconfigured variable or secret.
    const absent = runSecretGate(gateRun, {
      DSH_ISSUE_APP_CLIENT_ID: '',
      DSH_ISSUE_APP_PRIVATE_KEY: '',
    })
    expect(absent.status).toBe(0)
    expect(absent.output).toContain('enabled=false')
    expect(absent.output).toContain('DSH_ISSUE_APP_CLIENT_ID')

    const sentinel = 'app-key-sentinel'
    const present = runSecretGate(gateRun, {
      DSH_ISSUE_APP_CLIENT_ID: 'client-id-sentinel',
      DSH_ISSUE_APP_PRIVATE_KEY: sentinel,
    })
    expect(present.status).toBe(0)
    expect(present.output).toContain('enabled=true')
    expect(present.stdout).not.toContain(sentinel)
    expect(present.stderr).not.toContain(sentinel)

    // issue-policy owns PR validation; it is read-only and a real gate.
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('npm release workflows', () => {
  it('keeps publication dispatch-only and pack in the PR workflow', () => {
    // pack stays in the PR/master release workflows so a PR proves the set packs.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(['pack'])
    }

    // publication is workflow_dispatch-only (never a PR check) and keeps the
    // npm-publish environment plus the shared dist-tag group.
    for (const file of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define on and jobs`)
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      const publish = workflow.jobs.publish
      if (!isRecord(publish)) throw new TypeError(`${file} must define a publish job`)
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toMatchObject({ group: 'Release-publish' })
    }
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one parsed workflow step field: `run` and `uses` are YAML scalars, so only
 * a string carries command text and anything else reads as absent.
 */
function stepText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Run one workflow gate body with the environment GitHub would provide and report
 * its stdout, stderr and the `GITHUB_OUTPUT` file it wrote.
 * @param script - Gate body exactly as the workflow runs it.
 * @param environment - Variables passed to the gate (empty string models an unconfigured secret).
 * @returns Exit status, captured streams and the parsed output file.
 */
function runSecretGate(
  script: string,
  environment: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ark-ci-gate-'))
  const outputPath = join(directory, 'github-output.txt')
  try {
    const result = spawnSync('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...environment, GITHUB_OUTPUT: outputPath },
    })
    let output = ''
    try {
      output = readFileSync(outputPath, 'utf8')
    } catch {
      output = ''
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
