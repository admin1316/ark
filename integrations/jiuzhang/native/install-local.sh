#!/bin/zsh

# Assemble or validate an isolated Ark.app candidate. This helper never installs
# into /Applications; governed promotion owns production replacement and rollback.

set -euo pipefail

native_root="${0:A:h}"
placement="temporary"
do_build=1
while [[ "${#}" -gt 0 ]]; do
  case "${1}" in
    --desktop) placement="desktop" ;;
    --no-build) do_build=0 ;;
    --system)
      print -u2 "direct installation to /Applications/Ark.app is disabled"
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
  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  if [[ -n "${ARK_CANDIDATE_OUTPUT_ROOT:-}" ]]; then
    candidate_root="${ARK_CANDIDATE_OUTPUT_ROOT}"
  elif [[ "${placement}" == "desktop" ]]; then
    candidate_root="${HOME}/Desktop/Ark-Native-Candidates"
  else
    candidate_root="/private/tmp/ark-native-candidates"
  fi
  candidate_output="${candidate_root}/Ark-Candidate-${timestamp}-$$"
  built="$(zsh "${native_root}/build-app.sh" "${candidate_output}" | tail -1)"
else
  built="${ARK_APP_PATH:?--no-build requires ARK_APP_PATH}"
fi

zsh "${native_root}/build-app.sh" --check-candidate "${built}" >/dev/null
/usr/bin/codesign --verify --deep --strict "${built}"

print -r -- "Ark candidate ready: ${built}"
print -r -- "No installed application was modified."
print -r -- "Promotion to /Applications/Ark.app requires candidate acceptance, a unique rollback, and explicit authorization."
