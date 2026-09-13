#!/usr/bin/env bash
# Optional-secret gate for the opt-in live-API workflows.
#
# A live-API job must never fail merely because its optional repository secret
# is unconfigured: this gate reports presence and the workflow conditions its
# build/test steps on the emitted `enabled` output, so an unconfigured secret
# produces a skipped (neutral) run instead of a red one. Secret VALUES are
# never printed - only the environment-variable names.
#
# Usage: bash scripts/ci-secret-gate.sh ENV_NAME [ENV_NAME...]
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: ci-secret-gate.sh ENV_NAME [ENV_NAME...]" >&2
  exit 2
fi

missing=()
for name in "$@"; do
  if [ -z "${!name:-}" ]; then missing+=("$name"); fi
done

if [ "${#missing[@]}" -eq 0 ]; then
  enabled=true
  echo "Optional secret(s) present: $*"
else
  enabled=false
  echo "::notice::Skipping live-API steps: optional secret(s) not configured: ${missing[*]}"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "enabled=$enabled"
    echo "missing=${missing[*]:-}"
  } >> "$GITHUB_OUTPUT"
else
  echo "enabled=$enabled"
  echo "missing=${missing[*]:-}"
fi
