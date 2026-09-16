#!/bin/zsh

# Assemble or validate an isolated Ark.app candidate. This helper never installs
# into the production app; governed promotion owns replacement and rollback.

set -euo pipefail

native_root="${0:A:h}"
do_build=1
while [[ "${#}" -gt 0 ]]; do
  case "${1}" in
    --desktop) print -u2 "use the single fixed candidate at ~/ark-test/candidate/Ark.app"; exit 2 ;;
    --no-build) do_build=0 ;;
    --system)
      print -u2 "direct installation to ${HOME}/ark/Ark.app is disabled"
      print -u2 "build and validate an isolated candidate, then use the explicitly authorized governed promotion flow"
      exit 2
      ;;
    *) print -u2 "unknown option: ${1}"; exit 2 ;;
  esac
  shift
done

if [[ "${do_build}" == 1 ]]; then
  export JIUZHANG_SELF_CONTAINED=1
  export JIUZHANG_RUNTIME_ROOT="${JIUZHANG_RUNTIME_ROOT:-${HOME}/ark/jiuzhang-runtime}"
  export JIUZHANG_CANDIDATE_BUILD=1
  candidate_output="${ARK_CANDIDATE_OUTPUT_ROOT:-${HOME}/ark-test/candidate}"
  # The builder rejects an occupied slot. Stop and remove the previous verified
  # candidate before reuse; never overwrite a running app or create numbered copies.
  built="$(zsh "${native_root}/build-app.sh" "${candidate_output}" | tail -1)"
else
  built="${ARK_APP_PATH:?--no-build requires ARK_APP_PATH}"
fi

zsh "${native_root}/build-app.sh" --check-candidate "${built}" >/dev/null
/usr/bin/codesign --verify --deep --strict "${built}"

print -r -- "Ark candidate ready: ${built}"
print -r -- "No installed application was modified."
print -r -- "Promotion to ${HOME}/ark/Ark.app requires candidate acceptance, a unique rollback, and explicit authorization."
