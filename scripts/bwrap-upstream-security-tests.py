#!/usr/bin/env python3
"""Run the reviewed upstream security regressions for CVE-2026-87766.

The pinned bubblewrap release ships the regression that its own fix was merged
with, and that is what this adapter runs instead of a hand-written probe:

    TestSandbox.test_proc_symlink_escape_blocked
    TestSandbox.test_proc_symlink_escape_blocked_fallback

Both live in `tests/test-sandbox.py` of the verified `bubblewrap-0.12.0.tar.xz`
and model the advisory exactly: sandbox setup is asked to create a directory
below `/tmp/mnt/symlink`, where that symlink is an absolute symlink to
`/proc/self/fd/<escape_fd>` pointing at a host directory, and the test requires
bwrap to refuse while the host directory stays unchanged. A path that is merely
bind-mounted into the sandbox cannot be used as the observation point, which is
why the previous hand-written probe reported a false escape.

Trust rules, in order:
 * the upstream modules are loaded from the extracted pinned source tree, not
   from a network checkout of a moving branch;
 * `BWRAP` is the absolute path of the binary this run built and verified;
 * the two reviewed cases must exist in that tree and be selected;
 * a skip is a failure: `can_run_bwrap()` skipping the class means the tool
   could not run at all, which must never read as "the escape was blocked";
 * failures, errors and a wrong selected-test count are failures;
 * exit status: 0 only when both cases ran and passed.

The tests use only synthetic directories and marker files created under TMPDIR
by the upstream harness, which also hides /tmp inside the sandbox with a tmpfs.
"""

import argparse
import importlib.util
import os
import sys
import unittest

REVIEWED_TESTS = (
    'TestSandbox.test_proc_symlink_escape_blocked',
    'TestSandbox.test_proc_symlink_escape_blocked_fallback',
)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bwrap', required=True, help='absolute path of the built bubblewrap')
    parser.add_argument('--tests-dir', required=True, help='tests/ directory of the pinned source')
    options = parser.parse_args()

    bwrap = os.path.abspath(options.bwrap)
    if not os.path.isfile(bwrap) or not os.access(bwrap, os.X_OK):
        print(f'upstream-security: {bwrap} is not an executable file', file=sys.stderr)
        return 2

    test_sandbox = os.path.join(options.tests_dir, 'test-sandbox.py')
    if not os.path.isfile(test_sandbox):
        print(f'upstream-security: {test_sandbox} is missing from the pinned source', file=sys.stderr)
        return 2

    # The upstream helper reads BWRAP at import time and uses it for real.
    os.environ['BWRAP'] = bwrap
    try:
        module = load_module(test_sandbox, 'dsh_upstream_test_sandbox')
    except Exception as error:  # noqa: BLE001 -- any load failure is a failed gate
        print(f'upstream-security: cannot load the pinned test module: {error}', file=sys.stderr)
        return 2

    suite = unittest.TestSuite()
    for name in REVIEWED_TESTS:
        class_name, method_name = name.split('.', 1)
        test_class = getattr(module, class_name, None)
        if test_class is None or not hasattr(test_class, method_name):
            print(f'upstream-security: {name} is missing from the pinned source', file=sys.stderr)
            return 2
        suite.addTest(test_class(method_name))
    if suite.countTestCases() != len(REVIEWED_TESTS):
        print(f'upstream-security: selected {suite.countTestCases()} cases, expected {len(REVIEWED_TESTS)}', file=sys.stderr)
        return 2

    runner = unittest.TextTestRunner(stream=sys.stdout, verbosity=2)
    result = runner.run(suite)
    failures = len(result.failures)
    errors = len(result.errors)
    skipped = len(result.skipped)
    print(
        f'upstream-security: testsRun={result.testsRun} failures={failures} errors={errors} '
        f'skipped={skipped} selected={len(REVIEWED_TESTS)}',
    )
    for name in REVIEWED_TESTS:
        print(f'upstream-security: selected {name}')
    print(f'upstream-security: bwrap={bwrap}')
    if result.testsRun != len(REVIEWED_TESTS) or failures or errors or skipped:
        print('upstream-security: the reviewed security regressions did not all run and pass', file=sys.stderr)
        return 1
    print('upstream-security: passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
