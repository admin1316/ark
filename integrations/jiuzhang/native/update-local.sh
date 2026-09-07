#!/bin/zsh

# Production replacement is not an update-script responsibility. Keep this
# compatibility entry point candidate-only and delegate to the single owner.

set -euo pipefail

native_root="${0:A:h}"
exec zsh "${native_root}/install-local.sh" "${@}"
