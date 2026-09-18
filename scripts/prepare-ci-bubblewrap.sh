#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's package transaction scans the hosted image's full dpkg database and
# runs post-install hooks. CI needs only the signed-archive payload, so pin and
# verify that payload before extracting it into the ephemeral runner directory.
#
# Identity: 24.04 LTS (noble), amd64. Recorded 2026-09-18 from the archive's own
# signed indexes — dists/noble-updates/main/binary-amd64/Packages.gz and
# dists/noble-security/main/binary-amd64/Packages.gz both list
#   Package: bubblewrap
#   Version: 0.9.0-1ubuntu0.3
#   Architecture: amd64
#   Size: 50436
#   Filename: pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.3_amd64.deb
#   SHA256: 2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094
# The pinned digest is that index value, never a hash recomputed from a download,
# and every source below is an archive-owned copy of the same pool file.
#
# The previous pin (0.9.0-1ubuntu0.1) is gone from the pool, and this series is
# not fully patched: USN-8779-1 published 0.9.0-1ubuntu0.2, USN-8779-2 reverted
# that fix (CVE-2026-87766), the CVE page still lists 24.04 as vulnerable, and
# upstream fixes it only in bubblewrap 0.12.0. This CI tool therefore pins the
# current official security revision and claims no CVE-2026-87766 fix; the
# confinement probe below is a usability check, not a security attestation.
readonly BUBBLEWRAP_VERSION='0.9.0-1ubuntu0.3'
readonly BUBBLEWRAP_SHA256='2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094'
readonly BUBBLEWRAP_SIZE=50436
# Audited mirror list: archive.ubuntu.com is the archive of record and
# security.ubuntu.com serves the same pool file. Every entry must deliver the
# same bytes, so no option can silently select another revision or architecture.
readonly -a BUBBLEWRAP_URLS=(
  "https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
  "https://security.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
)
# Retries are bounded per source and a withdrawn artifact (HTTP 404) is not
# retried at all: it is a pool-state fact, not a transient network fault.
readonly BUBBLEWRAP_ATTEMPTS_PER_SOURCE=2
readonly BUBBLEWRAP_CONNECT_TIMEOUT_SECONDS=20
readonly BUBBLEWRAP_MAX_SECONDS=120

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

# A fresh download directory per run: a half-downloaded archive, or a directory
# left behind by an earlier attempt, is never trusted as a prepared payload.
download_dir="$(mktemp -d "${RUNNER_TEMP}/dsh-bubblewrap-download.XXXXXX")"
archive="${download_dir}/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-bubblewrap"

fetch_source() {
  local url="$1"
  local attempt status=1
  for ((attempt = 1; attempt <= BUBBLEWRAP_ATTEMPTS_PER_SOURCE; attempt += 1)); do
    curl --fail --silent --show-error --location \
      --connect-timeout "${BUBBLEWRAP_CONNECT_TIMEOUT_SECONDS}" --max-time "${BUBBLEWRAP_MAX_SECONDS}" \
      --output "$archive" "$url" && return 0
    # The AND list keeps this failure out of errexit and leaves curl's status here.
    status=$?
    echo "prepare-ci-bubblewrap: attempt ${attempt}/${BUBBLEWRAP_ATTEMPTS_PER_SOURCE} failed for ${url} (curl exit ${status})" >&2
    if ((status == 22)); then
      # curl --fail reports HTTP status >= 400 as exit 22.
      return "$status"
    fi
  done
  return "$status"
}

verify_archive() {
  local size sha package version architecture listing
  if [[ ! -f "$archive" ]]; then
    echo 'prepare-ci-bubblewrap: no payload was downloaded' >&2
    return 1
  fi
  size="$(wc -c < "$archive")"
  if ((size != BUBBLEWRAP_SIZE)); then
    echo "prepare-ci-bubblewrap: payload is ${size} bytes, expected ${BUBBLEWRAP_SIZE}" >&2
    return 1
  fi
  if ! printf '%s  %s\n' "$BUBBLEWRAP_SHA256" "$archive" | sha256sum --check --status; then
    echo 'prepare-ci-bubblewrap: payload digest does not match the pinned index value' >&2
    return 1
  fi
  package="$(dpkg-deb --field "$archive" Package)"
  version="$(dpkg-deb --field "$archive" Version)"
  architecture="$(dpkg-deb --field "$archive" Architecture)"
  if [[ "$package" != 'bubblewrap' || "$version" != "$BUBBLEWRAP_VERSION" || "$architecture" != 'amd64' ]]; then
    echo "prepare-ci-bubblewrap: unexpected payload identity ${package} ${version} ${architecture}" >&2
    return 1
  fi
  # grep -q would close the listing pipe early and pipefail would then read the
  # producer's SIGPIPE as a failure, so the listing is captured and matched.
  listing="$(dpkg-deb --contents "$archive")"
  if [[ "$listing" != *'./usr/bin/bwrap'* ]]; then
    echo 'prepare-ci-bubblewrap: payload does not contain usr/bin/bwrap' >&2
    return 1
  fi
  sha="$BUBBLEWRAP_SHA256"
  echo "prepare-ci-bubblewrap: verified ${package} ${version} ${architecture} sha256=${sha}" >&2
}

source_url=''
for url in "${BUBBLEWRAP_URLS[@]}"; do
  if fetch_source "$url"; then
    source_url="$url"
    break
  fi
  echo "prepare-ci-bubblewrap: source unusable: ${url}" >&2
done
if [[ -z "$source_url" ]]; then
  echo 'prepare-ci-bubblewrap: no audited source could deliver the pinned payload' >&2
  exit 1
fi

verify_archive

# Extract into a directory this run owns: a leftover tree from an earlier
# attempt cannot participate in the published payload.
rm -rf "$root"
mkdir -p "$root"
if ! dpkg-deb --extract "$archive" "$root"; then
  echo 'prepare-ci-bubblewrap: payload extraction failed' >&2
  exit 1
fi

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'

bwrap="${root}/usr/bin/bwrap"
# A version string is not confinement: the probe must create a namespace, bind
# the root read-only, and prove that the read-only bind is actually enforced
# before any consumer sees the payload on PATH.
"$bwrap" --version
"$bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
if "$bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent \
  -- /bin/sh -c 'exec 3>/usr/lib/.dsh-bwrap-probe'; then
  echo 'prepare-ci-bubblewrap: the read-only bind was writable; confinement probe failed' >&2
  exit 1
fi

printf '%s\n' "${root}/usr/bin" >> "$GITHUB_PATH"
echo "prepare-ci-bubblewrap: bubblewrap ${BUBBLEWRAP_VERSION} amd64 sha256=${BUBBLEWRAP_SHA256} source=${source_url} root=${root}"
echo 'bubblewrap functional probe passed'
