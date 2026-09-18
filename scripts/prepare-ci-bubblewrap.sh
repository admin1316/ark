#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's package transaction scans the hosted image's full dpkg database and
# runs post-install hooks, and the 24.04 package currently carries no fix for
# CVE-2026-87766: USN-8779-1 fixed it in 0.9.0-1ubuntu0.2, USN-8779-2 reverted
# that fix, and the CVE page still lists 24.04 LTS as vulnerable. Upstream fixes
# it only in bubblewrap 0.12.0, so CI builds that exact release from its published
# source asset into the ephemeral runner directory.
#
# Source identity, recorded 2026-09-18 from the GitHub release API and from a
# real download of both assets:
#   release: containers/bubblewrap v0.12.0, published 2026-08-26, tag object
#            014a04330642e5c870418beb621532cb896e0002 (annotated, PGP-signed;
#            GitHub reports verified=valid - platform metadata, not a local check)
#   asset 530629244 bubblewrap-0.12.0.tar.xz            126452 bytes
#   asset 530629263 bubblewrap-0.12.0.tar.xz.sha256sum      91 bytes
#   expected SHA-256 of the tarball   : 9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314
#   expected SHA-256 of the checksum  : 6f1804eb45fd2727e08b4964b64cadd699a1c8086a996f01db037e294db021fc
# The expected digests are the release's own metadata values, not a hash this
# script recomputed; the checksum asset must agree with the tarball digest, so a
# single substituted asset cannot pass.
#
# Build: the release's real requirements, read from meson.build and
# meson_options.txt of the extracted source (meson >= 0.49, libcap required,
# libselinux/man/tests optional). The binary is built non-setuid with no file
# capabilities: 0.12.0 removed setuid support entirely, and the build never
# installs into the system prefix.
readonly BWRAP_VERSION='0.12.0'
readonly BWRAP_TARBALL="bubblewrap-${BWRAP_VERSION}.tar.xz"
readonly BWRAP_TARBALL_SHA256='9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314'
readonly BWRAP_CHECKSUM_SHA256='6f1804eb45fd2727e08b4964b64cadd699a1c8086a996f01db037e294db021fc'
readonly BWRAP_RELEASE_BASE='https://github.com/containers/bubblewrap/releases/download/v0.12.0'
# One audited source: the pinned release asset itself. No mirror is configured
# because no second host was reviewed for this asset; retries stay bounded and a
# withdrawn artifact fails the step instead of switching to another revision.
readonly BWRAP_SOURCE="${BWRAP_RELEASE_BASE}/${BWRAP_TARBALL}"
# Retries are bounded per source and a withdrawn artifact (HTTP 404) is not
# retried at all: it is a release-state fact, not a transient network fault.
readonly BWRAP_ATTEMPTS_PER_SOURCE=2
readonly BWRAP_CONNECT_TIMEOUT_SECONDS=20
readonly BWRAP_MAX_SECONDS=180
readonly BWRAP_BUILD_PACKAGES='meson ninja-build gcc pkg-config libcap-dev'

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

# A fresh per-run directory: a half-downloaded archive, or a tree left behind by
# an earlier attempt, is never trusted as a prepared tool.
built_version=''
pinned_source=''
work="$(mktemp -d "${RUNNER_TEMP}/dsh-bubblewrap-build.XXXXXX")"
archive="${work}/${BWRAP_TARBALL}"
checksum_asset="${work}/${BWRAP_TARBALL}.sha256sum"
source_dir="${work}/source"
tool_dir="${RUNNER_TEMP}/dsh-bubblewrap"
published="${tool_dir}/usr/bin/bwrap"

fetch() {
  local url="$1" output="$2"
  local attempt status=1
  for ((attempt = 1; attempt <= BWRAP_ATTEMPTS_PER_SOURCE; attempt += 1)); do
    curl --fail --silent --show-error --location \
      --connect-timeout "${BWRAP_CONNECT_TIMEOUT_SECONDS}" --max-time "${BWRAP_MAX_SECONDS}" \
      --output "$output" "$url" && return 0
    # The AND list keeps this failure out of errexit and leaves curl's status here.
    status=$?
    echo "prepare-ci-bubblewrap: attempt ${attempt}/${BWRAP_ATTEMPTS_PER_SOURCE} failed for ${url} (curl exit ${status})" >&2
    if ((status == 22)); then
      # curl --fail reports HTTP status >= 400 as exit 22.
      return "$status"
    fi
  done
  return "$status"
}

fetch_pinned_asset() {
  # Returns the URL through the global: a command substitution would run this in
  # a subshell, where a failure could not stop the script.
  local output="$1"
  if fetch "$BWRAP_SOURCE" "$output"; then
    pinned_source="${BWRAP_SOURCE}"
    return 0
  fi
  echo "prepare-ci-bubblewrap: the pinned source is unavailable: ${BWRAP_SOURCE}" >&2
  return 1
}

verify_download() {
  local size
  if [[ ! -f "$archive" || ! -f "$checksum_asset" ]]; then
    echo 'prepare-ci-bubblewrap: a required asset was not downloaded' >&2
    return 1
  fi
  size="$(wc -c < "$archive")"
  if ((size == 0)); then
    echo 'prepare-ci-bubblewrap: the source tarball is empty' >&2
    return 1
  fi
  if ! printf '%s  %s\n' "$BWRAP_TARBALL_SHA256" "$archive" | sha256sum --check --status; then
    echo 'prepare-ci-bubblewrap: source tarball digest does not match the pinned release value' >&2
    return 1
  fi
  if ! printf '%s  %s\n' "$BWRAP_CHECKSUM_SHA256" "$checksum_asset" | sha256sum --check --status; then
    echo 'prepare-ci-bubblewrap: checksum asset digest does not match the pinned release value' >&2
    return 1
  fi
  # The two release assets must agree: the checksum file names the tarball and
  # the same digest, so a single substituted asset cannot satisfy both checks.
  if ! grep -qE "^[0-9a-f]{64} \*?${BWRAP_TARBALL}$" "$checksum_asset"; then
    echo 'prepare-ci-bubblewrap: checksum asset does not describe the pinned tarball' >&2
    return 1
  fi
  if ! grep -qF "$BWRAP_TARBALL_SHA256" "$checksum_asset"; then
    echo 'prepare-ci-bubblewrap: checksum asset carries a different digest' >&2
    return 1
  fi
  echo "prepare-ci-bubblewrap: verified ${BWRAP_TARBALL} sha256=${BWRAP_TARBALL_SHA256}" >&2
}

install_build_dependencies() {
  # Minimal official build dependencies for this release: meson/ninja plus the C
  # toolchain and libcap (required by meson.build). No package supplies bwrap
  # itself.
  if [[ "${RUNNER_ENVIRONMENT:-}" != 'github-hosted' ]]; then
    # Package installation is authorized only on the disposable hosted runner.
    # A self-hosted or user machine must already carry the reviewed toolchain.
    local tool
    for tool in meson ninja cc pkg-config; do
      if ! command -v "$tool" >/dev/null; then
        echo "prepare-ci-bubblewrap: non-hosted runner without ${tool}; refusing to install packages here" >&2
        return 1
      fi
    done
    if ! pkg-config --exists libcap; then
      echo 'prepare-ci-bubblewrap: non-hosted runner without libcap development files; refusing to install packages here' >&2
      return 1
    fi
    return 0
  fi
  sudo apt-get update -q
  # shellcheck disable=SC2086 -- the package list is a fixed, reviewed constant.
  sudo apt-get install -yq --no-install-recommends ${BWRAP_BUILD_PACKAGES}
}

build_bwrap() {
  tar -xf "$archive" -C "$work"
  source_dir="${work}/bubblewrap-${BWRAP_VERSION}"
  if [[ ! -f "${source_dir}/meson.build" ]]; then
    echo 'prepare-ci-bubblewrap: the source tree has no meson.build' >&2
    return 1
  fi
  if ! grep -qE "version : '${BWRAP_VERSION}'" "${source_dir}/meson.build"; then
    echo "prepare-ci-bubblewrap: the source tree is not bubblewrap ${BWRAP_VERSION}" >&2
    return 1
  fi
  install_build_dependencies
  # Build output stays on the job log; the function returns through the globals.
  meson setup "${source_dir}/build" "${source_dir}" \
    -Dtests=false -Dman=disabled -Dselinux=disabled --buildtype=release
  meson compile -C "${source_dir}/build" bwrap
  if [[ ! -x "${source_dir}/build/bwrap" ]]; then
    echo 'prepare-ci-bubblewrap: the build produced no bwrap executable' >&2
    return 1
  fi
}

verify_built_binary() {
  # Called directly, never inside a command substitution: an assignment such as
  # version="$(verify_built_binary)" would swallow this function's non-zero
  # return and let a refused binary continue into the publish step.
  local version size mode
  version="$("${source_dir}/build/bwrap" --version)"
  if [[ "$version" != "bubblewrap ${BWRAP_VERSION}" ]]; then
    echo "prepare-ci-bubblewrap: unexpected version string: ${version}" >&2
    return 1
  fi
  mode="$(stat -c '%a' "${source_dir}/build/bwrap")"
  # Pattern match instead of shell arithmetic: the setuid bit is the leading
  # octal digit (4-7) of a four-digit mode, and the arithmetic form is not
  # portable across the bash versions a developer machine may run the spec with.
  if [[ "$mode" == [4567]??? ]]; then
    echo 'prepare-ci-bubblewrap: refusing a setuid binary' >&2
    return 1
  fi
  if command -v getcap >/dev/null && [[ -n "$(getcap "${source_dir}/build/bwrap" 2>/dev/null)" ]]; then
    echo 'prepare-ci-bubblewrap: refusing a binary with file capabilities' >&2
    return 1
  fi
  built_version="$version"
}

run_isolation_probes() {
  local bwrap="$1"
  # (1) The namespace must really start and run a command.
  "$bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent \
    -- /bin/sh -c 'echo nested-ok'
  # (2) A directory this run owns is writable on the host before the sandbox...
  local control
  control="$(mktemp -d "${RUNNER_TEMP}/dsh-bwrap-control.XXXXXX")"
  printf 'host-marker' > "${control}/marker.txt"
  # ...and must be read-only inside it, with the refusal coming from the bind
  # rather than from a host permission this user never had.
  if "$bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent \
    -- /bin/sh -c "echo inner-started; printf inner > '${control}/inner.txt'" >"${work}/probe-out.txt" 2>"${work}/probe-err.txt"; then
    echo 'prepare-ci-bubblewrap: the read-only bind was writable inside the sandbox' >&2
    return 1
  fi
  if ! grep -q 'inner-started' "${work}/probe-out.txt"; then
    echo 'prepare-ci-bubblewrap: the sandboxed command never started' >&2
    return 1
  fi
  if ! grep -qiE 'read-only file system|permission denied' "${work}/probe-err.txt"; then
    echo 'prepare-ci-bubblewrap: the refusal did not come from the read-only bind' >&2
    return 1
  fi
  if [[ "$(cat "${control}/marker.txt")" != 'host-marker' ]]; then
    echo 'prepare-ci-bubblewrap: the host control file changed' >&2
    return 1
  fi
  if [[ -e "${control}/inner.txt" ]]; then
    echo 'prepare-ci-bubblewrap: the sandbox wrote into the host control directory' >&2
    return 1
  fi
}

run_symlink_escape_regression() {
  # CVE-2026-87766 / GHSA-pxhw-h44j-8pfx: sandbox setup could follow a parent
  # symlink out of the sandbox and create files or directories on the host.
  # 0.12.0 resolves absolute symlinks inside the sandbox root (openat2 with
  # RESOLVE_IN_ROOT, or the release's fallback), so a setup step that writes
  # under an absolute symlink must never reach the host directory it names.
  local bwrap="$1" escape_dir outside
  escape_dir="$(mktemp -d "${RUNNER_TEMP}/dsh-bwrap-escape.XXXXXX")"
  outside="${escape_dir}/outside"
  mkdir -p "${outside}" "${escape_dir}/sandbox"
  printf 'outside-marker' > "${outside}/marker.txt"
  ln -s "$outside" "${escape_dir}/sandbox/escape"
  "$bwrap" --ro-bind / / --bind "$escape_dir" "$escape_dir" --dev /dev --unshare-pid --proc /proc \
    --die-with-parent --dir "${escape_dir}/sandbox/escape/dsh-cve-probe" -- true >/dev/null 2>&1 || true
  if [[ -e "${outside}/dsh-cve-probe" ]]; then
    echo 'prepare-ci-bubblewrap: sandbox setup created a directory outside the sandbox' >&2
    return 1
  fi
  if [[ "$(cat "${outside}/marker.txt")" != 'outside-marker' ]]; then
    echo 'prepare-ci-bubblewrap: the host control directory changed during setup' >&2
    return 1
  fi
}

pinned_source=''
fetch_pinned_asset "$archive"
source_url="${pinned_source}"
fetch "${source_url}.sha256sum" "$checksum_asset" || {
  echo 'prepare-ci-bubblewrap: the checksum asset is unavailable from the audited source' >&2
  exit 1
}
verify_download

build_bwrap
built="${source_dir}/build/bwrap"
verify_built_binary
version="${built_version}"
: "$built" "$version"

rm -rf "$tool_dir"
mkdir -p "${tool_dir}/usr/bin"
cp "${source_dir}/build/bwrap" "$published"
chmod 0755 "$published"

run_isolation_probes "$published"
run_symlink_escape_regression "$published"

# Only a verified, built and probe-tested payload reaches the consumers.
printf '%s\n' "${tool_dir}/usr/bin" >> "$GITHUB_PATH"
binary_sha="$(sha256sum "$published" | cut -d' ' -f1)"
echo "prepare-ci-bubblewrap: bubblewrap ${BWRAP_VERSION} built from source sha256=${BWRAP_TARBALL_SHA256} binary_sha256=${binary_sha} source=${source_url} path=${published}"
echo 'bubblewrap functional probe passed'
echo 'bubblewrap CVE-2026-87766 symlink-escape regression passed'
