#!/bin/zsh

set -euo pipefail

native_root="${0:A:h}"
repository_root="${native_root:h:h:h}"
runtime_root="${repository_root}"
launcher_path="${runtime_root}/integrations/jiuzhang/src/start.mjs"
built_runner="${runtime_root}/packages/boot/native-api-runner/lib/bin.js"
icon_source="${native_root}/Resources/AppIcon.png"
wiki_background_source="${native_root}/Resources/WikiNeuralBackground.png"

function ark_refuse_unsafe_output() {
  local requested="${1}"
  [[ "${requested}" == /* ]] || {
    print -u2 "output directory must be absolute: ${requested}"
    return 2
  }
  [[ ! -e "${requested}" && ! -L "${requested}" ]] || {
    print -u2 "refusing to replace an existing Ark candidate unit: ${requested}"
    return 2
  }

  local canonical="${requested:A}"
  local padded="/${canonical#/}/"
  if [[ "${canonical}" == "/" || "${canonical}" == "/Applications" || "${canonical}" == /Applications/* ]]; then
    print -u2 "refusing Ark candidate output in the production application hierarchy: ${canonical}"
    return 2
  fi
  if [[ "${padded:l}" == *"/ark.app/"* ]]; then
    print -u2 "refusing an output directory inside an Ark.app bundle: ${canonical}"
    return 2
  fi
  [[ -d "${canonical:h}" && ! -L "${canonical:h}" ]] || {
    print -u2 "Ark candidate parent must be an existing ordinary directory: ${canonical:h}"
    return 2
  }
  print -r -- "${canonical}"
}

function ark_refuse_unsafe_candidate() {
  local requested="${1}"
  [[ "${requested}" == /* && "${requested:t}" == "Ark.app" ]] || {
    print -u2 "candidate must be an absolute Ark.app path: ${requested}"
    return 2
  }
  [[ ! -L "${requested}" ]] || {
    print -u2 "refusing link-shaped Ark.app candidate: ${requested}"
    return 2
  }
  local canonical="${requested:A}"
  [[ "${canonical}" != "/Applications/Ark.app" && "${canonical}" != /Applications/* ]] || {
    print -u2 "refusing the production Ark.app as a candidate: ${canonical}"
    return 2
  }
  [[ -d "${canonical}" ]] || {
    print -u2 "Ark.app candidate is unavailable: ${canonical}"
    return 2
  }
  print -r -- "${canonical}"
}

function ark_require_runtime_compatibility() {
  local settings_source="${1}"
  local candidate_runtime="${2}"
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the runtime compatibility check"
    return 2
  }

  local integration_root="${native_root:h}"
  local -a source_files=(
    "${integration_root}/src/start.mjs"
    "${integration_root}/src/runtime.mjs"
    "${integration_root}/src/runtime-closure.mjs"
    "${integration_root}/profile/package.json"
    "${integration_root}/profile/cordis.patch.yml"
    "${integration_root}/profile/pnpm-workspace.yaml"
    "${integration_root}/profile/runtime-identity-policy.json"
    "${integration_root}/profile/forbidden-runtime-packages.json"
  )
  local -a runtime_files=(
    "${candidate_runtime}/start.mjs"
    "${candidate_runtime}/runtime.mjs"
    "${candidate_runtime}/runtime-closure.mjs"
    "${candidate_runtime}/jiuzhang/profile/package.json"
    "${candidate_runtime}/jiuzhang/profile/cordis.patch.yml"
    "${candidate_runtime}/jiuzhang/profile/pnpm-workspace.yaml"
    "${candidate_runtime}/jiuzhang/profile/runtime-identity-policy.json"
    "${candidate_runtime}/jiuzhang/profile/forbidden-runtime-packages.json"
  )
  local index
  for (( index = 1; index <= ${#source_files}; index++ )); do
    local source_file="${source_files[${index}]}"
    local runtime_file="${runtime_files[${index}]}"
    [[ -f "${runtime_file}" && ! -L "${runtime_file}" ]] || {
      print -u2 "self-contained runtime lacks an ordinary current-source asset: ${runtime_file}"
      return 2
    }
    /usr/bin/cmp -s "${source_file}" "${runtime_file}" || {
      print -u2 "self-contained runtime carries a stale source asset: ${runtime_file}"
      return 2
    }
  done

  "${python}" - "${settings_source}" "${candidate_runtime}" <<'PYTHON' || return 2
from pathlib import Path
import json
import re
import sys

settings_source = Path(sys.argv[1])
runtime = Path(sys.argv[2])
if not settings_source.is_file():
    raise SystemExit(f"Native Provider client source is unavailable: {settings_source}")
if "llm/mutateProvider" not in settings_source.read_text():
    raise SystemExit(0)

def direct_package(name: str) -> Path:
    direct = runtime / "node_modules" / "@deepseek-ai" / name
    if not direct.is_dir():
        raise SystemExit(
            f"self-contained runtime lacks the direct @deepseek-ai/{name} package directory: {direct}"
        )
    try:
        package = direct.resolve(strict=True)
        package.relative_to(runtime.resolve(strict=True))
        return package
    except (FileNotFoundError, ValueError) as error:
        raise SystemExit(f"self-contained runtime has an invalid @deepseek-ai/{name} package link: {error}")

gateway_package = direct_package("dsh-api-gateway")
gateway_manifest_path = gateway_package / "package.json"
try:
    gateway_manifest = json.loads(gateway_manifest_path.read_text())
    gateway_main = gateway_manifest["main"]
except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError) as error:
    raise SystemExit(f"self-contained runtime has an invalid strict Gateway package manifest: {error}")
gateway_entry = gateway_package / gateway_main
if not gateway_entry.is_file():
    raise SystemExit(f"self-contained runtime lacks the strict Gateway package entry: {gateway_entry}")
gateway_source = gateway_entry.read_text()
for required in ("createTypertGatewayDispatcher", "llm/mutateProvider", "intercept(\"/api\""):
    if required not in gateway_source:
        raise SystemExit(f"self-contained runtime strict Gateway entry lacks {required}: {gateway_entry}")

llm_package = direct_package("dsh-llm")
for descriptor_name in ("typert.host.js", "typert.remote-client.js"):
    descriptor = llm_package / "lib" / descriptor_name
    if not descriptor.is_file():
        raise SystemExit(f"self-contained runtime lacks the LLM Remote descriptor: {descriptor}")
    descriptor_source = descriptor.read_text()
    if "llm/mutateProvider" not in descriptor_source or "service: 'llm'" not in descriptor_source:
        raise SystemExit(f"self-contained runtime LLM descriptor lacks llm/mutateProvider: {descriptor}")

inventory_direct = runtime / "node_modules" / "@deepseek-ai" / "dsh-host-plugin-inventory"
if not inventory_direct.is_dir():
    raise SystemExit(
        "self-contained runtime lacks the direct @deepseek-ai/dsh-host-plugin-inventory package directory: "
        f"{inventory_direct}"
    )
try:
    inventory_package = inventory_direct.resolve(strict=True)
    inventory_package.relative_to(runtime.resolve(strict=True))
except (FileNotFoundError, ValueError) as error:
    raise SystemExit(f"self-contained runtime has an invalid Host plugin inventory package link: {error}")

inventory_entry = inventory_package / "lib" / "index.js"
inventory_typert = inventory_package / "lib" / "typert.host.js"
inventory_remote = inventory_package / "lib" / "typert.remote-client.js"
for artifact in (inventory_entry, inventory_typert, inventory_remote):
    if not artifact.is_file():
        raise SystemExit(f"self-contained runtime lacks a built plugin inventory artifact: {artifact}")
if re.search(r"super\(ctx,\s*[\"']pluginInventory[\"']", inventory_entry.read_text()) is None \
        or re.search(r"Remote\([\"']list[\"']\)", inventory_entry.read_text()) is None:
    raise SystemExit(f"self-contained runtime plugin inventory entry lacks its list Remote: {inventory_entry}")
for descriptor in (inventory_typert, inventory_remote):
    if "pluginInventory/list" not in descriptor.read_text():
        raise SystemExit(f"self-contained runtime plugin inventory descriptor lacks pluginInventory/list: {descriptor}")
PYTHON
  local closure_checker="${native_root:h}/src/runtime-closure.mjs"
  local closure_policy="${native_root:h}/profile/forbidden-runtime-packages.json"
  local closure_node="$(command -v node)"
  [[ -x "${closure_node}" && -r "${closure_checker}" && -r "${closure_policy}" ]] || {
    print -u2 "Ark runtime closure checker is unavailable"
    return 2
  }
  [[ -r "${candidate_runtime}/runtime-closure.mjs" \
    && -r "${candidate_runtime}/jiuzhang/profile/forbidden-runtime-packages.json" ]] || {
    print -u2 "self-contained runtime lacks its closure checker or package policy"
    return 2
  }
  local -a closure_arguments=("${candidate_runtime}" "${closure_policy}")
  local installed_manifest="${candidate_runtime}/.ark-provenance/installed-runtime-manifest.json"
  if [[ -f "${installed_manifest}" && ! -L "${installed_manifest}" ]]; then
    closure_arguments+=(--allow-duplicates-from "${installed_manifest}")
  fi
  "${closure_node}" "${closure_checker}" "${closure_arguments[@]}" >/dev/null || return 2
}

function ark_require_pack_receipt() {
  local candidate_runtime="${1}"
  local receipt_path="${2}"
  local final_node="${3}"
  [[ "${receipt_path}" == /* && -f "${receipt_path}" && ! -L "${receipt_path}" ]] || {
    print -u2 "JIUZHANG_PACK_RECEIPT must name an absolute ordinary pack-receipt.json"
    return 2
  }
  [[ "${receipt_path:t}" == "pack-receipt.json" ]] || {
    print -u2 "JIUZHANG_PACK_RECEIPT must name pack-receipt.json"
    return 2
  }
  local closure_checker="${native_root:h}/src/runtime-closure.mjs"
  local closure_policy="${native_root:h}/profile/forbidden-runtime-packages.json"
  local plan_checker="${native_root:h}/src/runtime-plan.mjs"
  "${final_node}" "${closure_checker}" "${candidate_runtime}" "${closure_policy}" \
    --receipt "${receipt_path}" --node "${final_node}" \
    --source-plan "${plan_checker}" --repository-root "${repository_root}" \
    >/dev/null || return 2
  print -r -- "verified bound frozen/offline Ark runtime receipt"
}

function ark_runtime_browser_assets() {
  local action="${1}"
  local candidate_runtime="${2}"
  [[ "${action}" == "preflight" || "${action}" == "check" || "${action}" == "prune" ]] || {
    print -u2 "runtime browser-asset action must be preflight, check, or prune"
    return 2
  }
  [[ "${candidate_runtime}" == /* && -d "${candidate_runtime}" && ! -L "${candidate_runtime}" ]] || {
    print -u2 "runtime browser-asset root must be an absolute ordinary directory: ${candidate_runtime}"
    return 2
  }
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the runtime browser-asset check"
    return 2
  }

  "${python}" - "${action}" "${candidate_runtime}" <<'PYTHON' || return 2
from pathlib import Path
import json
import os
import shutil
import sys

action = sys.argv[1]
runtime = Path(sys.argv[2]).resolve(strict=True)
node_modules = runtime / "node_modules"
if not node_modules.is_dir() or node_modules.is_symlink():
    raise SystemExit(f"runtime browser-asset root lacks ordinary node_modules: {node_modules}")

web_suffixes = {".html", ".htm", ".css", ".scss", ".sass", ".less"}
prune_policy = {
    "@mixmark-io/domino": ("test",),
    "bignumber.js": ("doc",),
    "pdfjs-dist": ("web", "legacy/web"),
    "tesseract.js": ("examples",),
    "tslib": ("tslib.es6.html", "tslib.html"),
}

def ordinary_package_roots():
    roots = []
    for directory, names, files in os.walk(node_modules, followlinks=False):
        names[:] = [name for name in names if not (Path(directory) / name).is_symlink()]
        if "package.json" not in files:
            continue
        package_root = Path(directory)
        manifest_path = package_root / "package.json"
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise SystemExit(f"runtime package manifest is not an ordinary file: {manifest_path}")
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit(f"runtime package manifest is invalid: {manifest_path}: {error}")
        name = manifest.get("name")
        if name in prune_policy:
            roots.append((name, package_root))
    return roots

targets = []
for package_name, package_root in ordinary_package_roots():
    for relative in prune_policy[package_name]:
        target = package_root / relative
        try:
            target.relative_to(runtime)
        except ValueError as error:
            raise SystemExit(f"runtime browser-asset target escapes runtime: {target}") from error
        if target.is_symlink():
            raise SystemExit(f"runtime browser-asset target is a symlink: {target}")
        if target.exists():
            targets.append(target)

assets = sorted(
    path for path in runtime.rglob("*")
    if path.is_file() and not path.is_symlink() and path.suffix.casefold() in web_suffixes
)
unexpected = [
    path for path in assets
    if not any(path == target or target in path.parents for target in targets)
]
if unexpected:
    rendered = "\n".join(str(path.relative_to(runtime)) for path in unexpected)
    raise SystemExit(f"runtime contains unaudited HTML/CSS-family assets:\n{rendered}")

if action == "preflight":
    print(
        "runtime browser-asset preflight accepted "
        f"{len(assets)} audited HTML/CSS-family files across {len(set(targets))} targets"
    )
    raise SystemExit(0)

if action == "check":
    if assets:
        rendered = "\n".join(str(path.relative_to(runtime)) for path in assets)
        raise SystemExit(f"runtime retains audited browser-only assets:\n{rendered}")
    print("runtime browser-asset check accepted zero HTML/CSS-family files")
    raise SystemExit(0)

removed_files = len(assets)
removed_bytes = sum(path.stat().st_size for path in assets)
for target in sorted(set(targets), key=lambda path: len(path.parts), reverse=True):
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()

remaining = sorted(
    path for path in runtime.rglob("*")
    if path.is_file() and not path.is_symlink() and path.suffix.casefold() in web_suffixes
)
if remaining:
    rendered = "\n".join(str(path.relative_to(runtime)) for path in remaining)
    raise SystemExit(f"runtime browser-asset prune left HTML/CSS-family files:\n{rendered}")
print(
    "runtime browser-asset prune removed "
    f"{removed_files} audited files ({removed_bytes} bytes) across {len(set(targets))} targets"
)
PYTHON
}

function ark_runtime_install_state() {
  local action="${1}"
  local candidate_runtime="${2}"
  [[ "${action}" == "check" || "${action}" == "prune" ]] || {
    print -u2 "runtime install-state action must be check or prune"
    return 2
  }
  [[ "${candidate_runtime}" == /* && -d "${candidate_runtime}" && ! -L "${candidate_runtime}" ]] || {
    print -u2 "runtime install-state root must be an absolute ordinary directory: ${candidate_runtime}"
    return 2
  }
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the runtime install-state check"
    return 2
  }

  "${python}" - "${action}" "${candidate_runtime}" <<'PYTHON' || return 2
from pathlib import Path
import stat
import sys

action = sys.argv[1]
runtime = Path(sys.argv[2]).resolve(strict=True)
targets = [
    runtime / "node_modules/.modules.yaml",
    runtime / "node_modules/.pnpm-workspace-state-v1.json",
]

present = []
for target in targets:
    try:
        identity = target.lstat()
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(identity.st_mode) or not stat.S_ISREG(identity.st_mode):
        raise SystemExit(f"runtime install-state target is not an ordinary file: {target}")
    present.append(target)

if action == "check":
    if present:
        rendered = "\n".join(str(path.relative_to(runtime)) for path in present)
        raise SystemExit(f"runtime retains package-manager install state:\n{rendered}")
    print("runtime install-state check accepted zero package-manager state files")
    raise SystemExit(0)

for target in present:
    target.unlink()
remaining = [target for target in targets if target.exists() or target.is_symlink()]
if remaining:
    raise SystemExit("runtime install-state prune left package-manager state files")
print(f"runtime install-state prune removed {len(present)} package-manager state files")
PYTHON
}

function ark_normalize_runtime_macho_ids() {
  local candidate_runtime="${1}"
  [[ "${candidate_runtime}" == /* && -d "${candidate_runtime}" && ! -L "${candidate_runtime}" ]] || {
    print -u2 "runtime Mach-O root must be an absolute ordinary directory: ${candidate_runtime}"
    return 2
  }
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the runtime Mach-O check"
    return 2
  }
  for tool in /usr/bin/file /usr/bin/otool /usr/bin/install_name_tool; do
    [[ -x "${tool}" ]] || {
      print -u2 "required Mach-O tool is unavailable: ${tool}"
      return 2
    }
  done

  "${python}" - "${candidate_runtime}" <<'PYTHON' || return 2
from pathlib import Path
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

runtime = Path(sys.argv[1]).resolve(strict=True)
normalized_canvas_id = "@rpath/skia.darwin-arm64.node"
build_prefixes = (
    "/Users/",
    "/private/tmp/",
    "/tmp/",
    "/Library/Developer/",
    "/Applications/Xcode",
)
canvas_package_name = "@napi-rs/canvas-darwin-arm64"

def candidate_files():
    for directory, names, files in os.walk(runtime, followlinks=False):
        names[:] = [name for name in names if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue
            mode = path.stat().st_mode
            if path.suffix.casefold() in {".node", ".dylib", ".so"} or mode & (
                stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
            ):
                kind = subprocess.run(
                    ["/usr/bin/file", "-b", str(path)],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
                if "Mach-O" in kind:
                    yield path

def dylib_paths(path):
    output = subprocess.run(
        ["/usr/bin/otool", "-l", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    pending = None
    for raw in output:
        line = raw.strip()
        if line == "cmd LC_ID_DYLIB":
            pending = "id"
            continue
        if line in {
            "cmd LC_LOAD_DYLIB",
            "cmd LC_LOAD_WEAK_DYLIB",
            "cmd LC_REEXPORT_DYLIB",
            "cmd LC_LOAD_UPWARD_DYLIB",
            "cmd LC_LAZY_LOAD_DYLIB",
        }:
            pending = "load"
            continue
        if line == "cmd LC_RPATH":
            pending = "rpath"
            continue
        if pending is not None and line.startswith("name "):
            match = re.fullmatch(r"name (.+) \(offset [0-9]+\)", line)
            if match is None:
                raise SystemExit(f"runtime Mach-O has an unparsable load command: {path}: {line}")
            yield pending, match.group(1)
            pending = None
            continue
        if pending == "rpath" and line.startswith("path "):
            match = re.fullmatch(r"path (.+) \(offset [0-9]+\)", line)
            if match is None:
                raise SystemExit(f"runtime Mach-O has an unparsable RPATH: {path}: {line}")
            yield pending, match.group(1)
            pending = None

def safe_runtime_rpath(value):
    return (
        value == "/usr/lib/swift"
        or value in {"@loader_path", "@executable_path"}
        or value.startswith("@loader_path/")
        or value.startswith("@executable_path/")
    )

system_framework_pattern = re.compile(
    r"/System/Library/Frameworks/[A-Za-z0-9_.+-]+\.framework/"
    r"Versions/[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+"
)
system_library_pattern = re.compile(
    r"/usr/lib/(?:libSystem\.B|libc\+\+\.1|libobjc\.A|libiconv\.2|libresolv\.9)\.dylib"
)
system_swift_pattern = re.compile(r"/usr/lib/swift/libswift[A-Za-z0-9_]+\.dylib")

def safe_system_dependency(value):
    return any(pattern.fullmatch(value) for pattern in (
        system_framework_pattern,
        system_library_pattern,
        system_swift_pattern,
    ))

def safe_runtime_command(kind, value):
    if kind == "rpath":
        return safe_runtime_rpath(value)
    if kind == "load":
        return (
            safe_system_dependency(value)
            or value.startswith("@rpath/")
            or value.startswith("@loader_path/")
            or value.startswith("@executable_path/")
        )
    if kind == "id":
        return (
            value.startswith("@rpath/")
            or value.startswith("@loader_path/")
            or value.startswith("@executable_path/")
        )
    return False

def canvas_addon(path):
    if path.name != "skia.darwin-arm64.node":
        return False
    manifest_path = path.parent / "package.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Canvas package manifest is invalid: {manifest_path}: {error}")
    return manifest.get("name") == canvas_package_name

candidates = list(candidate_files())
build_paths = []
canvas_old_ids = {}
canvas_ids = {}
for path in candidates:
    commands = list(dylib_paths(path))
    if canvas_addon(path):
        ids = [value for kind, value in commands if kind == "id"]
        canvas_ids[path] = ids
        if ids == [normalized_canvas_id]:
            pass
        elif len(ids) == 1 and re.fullmatch(
            r"/Users/runner/work/canvas/canvas/target/[^/]+/release/deps/libcanvas\.dylib",
            ids[0],
        ):
            canvas_old_ids[path] = ids[0]
        else:
            raise SystemExit(
                f"Canvas Mach-O has an unaudited install id: {path.relative_to(runtime)} -> {ids}"
            )
    for kind, value in commands:
        unsafe_command = not safe_runtime_command(kind, value)
        if not value.startswith(build_prefixes) and not unsafe_command:
            continue
        if kind == "id" and canvas_old_ids.get(path) == value:
            continue
        build_paths.append((path, kind, value))

# Reject every unknown build-machine path before changing the known Canvas ID.
if build_paths:
    rendered = "\n".join(
        f"{path.relative_to(runtime)} [{kind}] -> {value}"
        for path, kind, value in build_paths
    )
    raise SystemExit(f"runtime contains unaudited Mach-O paths:\n{rendered}")

canvas_physical_paths = {}
for path in candidates:
    metadata = path.stat()
    canvas_physical_paths.setdefault((metadata.st_dev, metadata.st_ino), []).append(path)
for path in canvas_ids:
    metadata = path.stat()
    aliases = canvas_physical_paths[(metadata.st_dev, metadata.st_ino)]
    if len(aliases) != 1:
        rendered = "\n".join(str(alias.relative_to(runtime)) for alias in aliases)
        raise SystemExit(f"Canvas Mach-O has multiple physical aliases:\n{rendered}")
if len(canvas_ids) > 1:
    rendered = "\n".join(str(path.relative_to(runtime)) for path in sorted(canvas_ids))
    raise SystemExit(f"runtime contains multiple physical Canvas Mach-O copies:\n{rendered}")

normalized = 0
for path in sorted(canvas_old_ids):
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.canvas-id.",
        dir=path.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.unlink()
        shutil.copy2(path, temporary)
        subprocess.run(
            ["/usr/bin/install_name_tool", "-id", normalized_canvas_id, str(temporary)],
            check=True,
        )
        temporary_ids = [value for kind, value in dylib_paths(temporary) if kind == "id"]
        if temporary_ids != [normalized_canvas_id]:
            raise SystemExit(f"Canvas Mach-O temporary normalization failed: {temporary_ids}")
        os.replace(temporary, path)
        final_ids = [value for kind, value in dylib_paths(path) if kind == "id"]
        if final_ids != [normalized_canvas_id]:
            raise SystemExit(f"Canvas Mach-O atomic replacement failed: {final_ids}")
        normalized += 1
    finally:
        temporary.unlink(missing_ok=True)

remaining = []
for path in candidate_files():
    commands = list(dylib_paths(path))
    if canvas_addon(path):
        ids = [value for kind, value in commands if kind == "id"]
        if ids != [normalized_canvas_id]:
            remaining.append((path, "id", repr(ids)))
    for kind, value in commands:
        if value.startswith(build_prefixes) or not safe_runtime_command(kind, value):
            remaining.append((path, kind, value))
if remaining:
    rendered = "\n".join(
        f"{path.relative_to(runtime)} [{kind}] -> {value}"
        for path, kind, value in remaining
    )
    raise SystemExit(f"runtime Mach-O normalization left unaudited paths or IDs:\n{rendered}")
print(
    f"runtime Mach-O check accepted {len(candidates)} files; "
    f"Canvas package copies={len(canvas_ids)} normalized physical IDs={normalized}"
)
PYTHON
}

function ark_main_swift_rpaths() {
  local action="${1}"
  local main_binary="${2}"
  [[ "${action}" == "check" || "${action}" == "prune" ]] || {
    print -u2 "main Swift RPATH action must be check or prune"
    return 2
  }
  [[ "${main_binary}" == /* && -f "${main_binary}" && ! -L "${main_binary}" ]] || {
    print -u2 "main Swift RPATH target must be an absolute ordinary file: ${main_binary}"
    return 2
  }
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the main Swift RPATH check"
    return 2
  }
  for tool in /usr/bin/file /usr/bin/otool /usr/bin/install_name_tool; do
    [[ -x "${tool}" ]] || {
      print -u2 "required main Mach-O tool is unavailable: ${tool}"
      return 2
    }
  done

  "${python}" - "${action}" "${main_binary}" <<'PYTHON' || return 2
from pathlib import Path
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

action = sys.argv[1]
binary = Path(sys.argv[2])
identity = binary.lstat()
if stat.S_ISLNK(identity.st_mode) or not stat.S_ISREG(identity.st_mode):
    raise SystemExit(f"main Swift RPATH target is not an ordinary file: {binary}")

kind = subprocess.run(
    ["/usr/bin/file", "-b", str(binary)],
    check=True,
    capture_output=True,
    text=True,
).stdout
if "Mach-O" not in kind:
    raise SystemExit(f"main Swift RPATH target is not Mach-O: {binary}")

safe_rpaths = {
    "/usr/lib/swift",
    "@loader_path",
    "@executable_path/../Frameworks",
    "@loader_path/../Frameworks",
}
toolchain_patterns = (
    re.compile(
        r"/Library/Developer/CommandLineTools/usr/lib/swift"
        r"(?:-[0-9]+(?:\.[0-9]+)*)?/macosx"
    ),
    re.compile(
        r"/Applications/Xcode(?:[- ][^/]*)?\.app/Contents/Developer/Toolchains/"
        r"XcodeDefault\.xctoolchain/usr/lib/swift(?:-[0-9]+(?:\.[0-9]+)*)?/macosx"
    ),
)
build_prefixes = (
    "/Users/",
    "/private/tmp/",
    "/tmp/",
    "/Library/Developer/",
    "/Applications/Xcode",
)

def load_commands(path: Path):
    return subprocess.run(
        ["/usr/bin/otool", "-l", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

def rpaths(path: Path):
    values = []
    pending = False
    for raw in load_commands(path):
        line = raw.strip()
        if line == "cmd LC_RPATH":
            pending = True
            continue
        if pending and line.startswith("path "):
            match = re.fullmatch(r"path (.+) \(offset [0-9]+\)", line)
            if match is None:
                raise SystemExit(f"main Mach-O has an unparsable RPATH: {path}: {line}")
            values.append(match.group(1))
            pending = False
    return values

def dependencies(path: Path):
    values = []
    pending = False
    dependency_commands = {
        "cmd LC_LOAD_DYLIB",
        "cmd LC_LOAD_WEAK_DYLIB",
        "cmd LC_REEXPORT_DYLIB",
        "cmd LC_LOAD_UPWARD_DYLIB",
        "cmd LC_LAZY_LOAD_DYLIB",
    }
    for raw in load_commands(path):
        line = raw.strip()
        if line in dependency_commands:
            pending = True
            continue
        if pending and line.startswith("name "):
            match = re.fullmatch(r"name (.+) \(offset [0-9]+\)", line)
            if match is None:
                raise SystemExit(f"main Mach-O has an unparsable dependency: {path}: {line}")
            values.append(match.group(1))
            pending = False
    return values

def safe_dependency(value: str):
    return any(pattern.fullmatch(value) for pattern in (
        re.compile(
            r"/System/Library/Frameworks/[A-Za-z0-9_.+-]+\.framework/"
            r"Versions/[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+"
        ),
        re.compile(r"/usr/lib/(?:libSystem\.B|libc\+\+\.1|libobjc\.A)\.dylib"),
        re.compile(r"/usr/lib/swift/libswift[A-Za-z0-9_]+\.dylib"),
    ))

def validate(path: Path, allow_toolchain: bool):
    values = rpaths(path)
    duplicates = sorted({value for value in values if values.count(value) > 1})
    if duplicates:
        raise SystemExit("main Mach-O has duplicate RPATHs:\n" + "\n".join(duplicates))
    toolchain = [
        value for value in values
        if any(pattern.fullmatch(value) for pattern in toolchain_patterns)
    ]
    unknown = [value for value in values if value not in safe_rpaths and value not in toolchain]
    if unknown:
        raise SystemExit("main Mach-O has unaudited RPATHs:\n" + "\n".join(unknown))
    if toolchain and not allow_toolchain:
        raise SystemExit(
            "main Mach-O retains build-toolchain Swift RPATHs:\n" + "\n".join(toolchain)
        )
    loaded = dependencies(path)
    leaked_dependencies = [value for value in loaded if value.startswith(build_prefixes)]
    if leaked_dependencies:
        raise SystemExit(
            "main Mach-O retains build-machine dynamic dependencies:\n"
            + "\n".join(leaked_dependencies)
        )
    unknown_dependencies = [value for value in loaded if not safe_dependency(value)]
    if unknown_dependencies:
        raise SystemExit(
            "main Mach-O has unaudited dynamic dependencies:\n"
            + "\n".join(unknown_dependencies)
        )
    return values, toolchain

values, removable = validate(binary, allow_toolchain=action == "prune")
if action == "check" or not removable:
    print(
        f"main Swift RPATH check accepted {len(values)} entries; "
        f"build-toolchain entries={len(removable)}"
    )
    raise SystemExit(0)

# Change a same-directory copy and atomically replace the unsigned build output
# only after every path and dependency postcondition passes. A rejected or
# interrupted normalization therefore leaves the original executable intact.
descriptor, temporary_name = tempfile.mkstemp(
    prefix=f".{binary.name}.swift-rpath.",
    dir=binary.parent,
)
os.close(descriptor)
temporary = Path(temporary_name)
try:
    temporary.unlink()
    shutil.copy2(binary, temporary)
    for value in removable:
        subprocess.run(
            ["/usr/bin/install_name_tool", "-delete_rpath", value, str(temporary)],
            check=True,
        )
    normalized, remaining = validate(temporary, allow_toolchain=False)
    if remaining:
        raise SystemExit("main Swift RPATH normalization left build-toolchain entries")
    os.replace(temporary, binary)
    final_values, final_remaining = validate(binary, allow_toolchain=False)
    if final_remaining or final_values != normalized:
        raise SystemExit("main Swift RPATH atomic replacement failed post-validation")
finally:
    temporary.unlink(missing_ok=True)

print(
    f"main Swift RPATH normalization removed {len(removable)} build-toolchain entries; "
    f"retained={len(final_values)}"
)
PYTHON
}

function ark_node_pty_macos_arm64() {
  local action="${1}"
  local candidate_runtime="${2}"
  [[ "${action}" == "check" || "${action}" == "prune" ]] || {
    print -u2 "node-pty packaging action must be check or prune"
    return 2
  }
  [[ "${candidate_runtime}" == /* && -d "${candidate_runtime}" && ! -L "${candidate_runtime}" ]] || {
    print -u2 "node-pty runtime must be an absolute ordinary directory: ${candidate_runtime}"
    return 2
  }
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the node-pty packaging check"
    return 2
  }
  [[ -x /usr/bin/lipo ]] || {
    print -u2 "lipo is unavailable for the node-pty architecture check"
    return 2
  }

  "${python}" - "${action}" "${candidate_runtime}" <<'PYTHON' || return 2
from pathlib import Path
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys

action = sys.argv[1]
runtime = Path(sys.argv[2]).resolve(strict=True)
node_modules = runtime / "node_modules"


def lstat(path: Path, description: str) -> os.stat_result:
    try:
        return os.lstat(path)
    except OSError as error:
        raise SystemExit(f"node-pty cannot inspect {description}: {path}: {error}") from error


def require_ordinary_directory(path: Path, description: str) -> os.stat_result:
    try:
        result = os.lstat(path)
    except OSError as error:
        raise SystemExit(f"node-pty requires an ordinary {description}: {path}: {error}") from error
    if not stat.S_ISDIR(result.st_mode):
        raise SystemExit(f"node-pty requires an ordinary {description}: {path}")
    return result


def require_ordinary_file(path: Path, description: str) -> os.stat_result:
    try:
        result = os.lstat(path)
    except OSError as error:
        raise SystemExit(f"node-pty lacks ordinary {description}: {path}: {error}") from error
    if not stat.S_ISREG(result.st_mode):
        raise SystemExit(f"node-pty lacks ordinary {description}: {path}")
    return result


require_ordinary_directory(runtime, "runtime directory")
require_ordinary_directory(node_modules, "node_modules directory")


def require_strict_descendant(path: Path, root: Path, description: str) -> None:
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise SystemExit(f"node-pty {description} escapes its package root: {path} -> {root}") from error
    if not relative.parts:
        raise SystemExit(f"node-pty {description} must be strictly inside its package root: {path}")


def require_inside_runtime(path: Path) -> Path:
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f"node-pty package cannot be resolved: {path}: {error}") from error
    require_strict_descendant(resolved, runtime, "package")
    require_ordinary_directory(resolved, "physical package directory")
    return resolved


def read_file_stably(path: Path, expected: os.stat_result) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SystemExit(f"node-pty cannot open an ordinary file without following links: {path}: {error}") from error
    try:
        opened = os.fstat(descriptor)
        expected_identity = (
            expected.st_dev,
            expected.st_ino,
            expected.st_mode,
            expected.st_size,
            expected.st_mtime_ns,
        )
        opened_identity = (
            opened.st_dev,
            opened.st_ino,
            opened.st_mode,
            opened.st_size,
            opened.st_mtime_ns,
        )
        if opened_identity != expected_identity:
            raise SystemExit(f"node-pty file identity changed while hashing: {path}")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        closed_identity = os.fstat(descriptor)
        if (
            closed_identity.st_dev,
            closed_identity.st_ino,
            closed_identity.st_mode,
            closed_identity.st_size,
            closed_identity.st_mtime_ns,
        ) != expected_identity:
            raise SystemExit(f"node-pty file changed while reading: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def file_digest(path: Path, expected: os.stat_result) -> str:
    return hashlib.sha256(read_file_stably(path, expected)).hexdigest()


def read_ordinary_text(path: Path, description: str) -> str:
    expected = require_ordinary_file(path, description)
    try:
        return read_file_stably(path, expected).decode("utf-8")
    except UnicodeDecodeError as error:
        raise SystemExit(f"node-pty {description} is not UTF-8: {path}: {error}") from error


def path_snapshot(path: Path) -> tuple[object, ...]:
    result = lstat(path, "path snapshot")
    base: tuple[object, ...] = (
        result.st_dev,
        result.st_ino,
        result.st_mode,
        result.st_size,
        result.st_mtime_ns,
    )
    if stat.S_ISREG(result.st_mode):
        return (*base, "file", file_digest(path, result))
    if stat.S_ISDIR(result.st_mode):
        return (*base, "directory")
    if stat.S_ISLNK(result.st_mode):
        return (*base, "symlink", os.readlink(path))
    return (*base, "special")


def tree_snapshot(root: Path, reject_links: bool = False) -> tuple[tuple[str, tuple[object, ...]], ...]:
    records: list[tuple[str, tuple[object, ...]]] = [(".", path_snapshot(root))]
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        names.sort()
        files.sort()
        current = Path(directory)
        retained_names: list[str] = []
        for name in names:
            path = current / name
            snapshot = path_snapshot(path)
            records.append((str(path.relative_to(root)), snapshot))
            mode = snapshot[2]
            if not (stat.S_ISDIR(mode) or stat.S_ISLNK(mode)) or (reject_links and stat.S_ISLNK(mode)):
                raise SystemExit(f"node-pty package contains an unsafe path: {path}")
            if stat.S_ISDIR(mode):
                retained_names.append(name)
        names[:] = retained_names
        for name in files:
            path = current / name
            snapshot = path_snapshot(path)
            records.append((str(path.relative_to(root)), snapshot))
            mode = snapshot[2]
            if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)) or (reject_links and stat.S_ISLNK(mode)):
                raise SystemExit(f"node-pty package contains an unsafe path: {path}")
    return tuple(sorted(records))


def discover_packages() -> tuple[tuple[Path, tuple[tuple[Path, tuple[object, ...]], ...]], ...]:
    aliases: dict[Path, list[tuple[Path, tuple[object, ...]]]] = {}
    for directory, names, _ in os.walk(node_modules, topdown=True, followlinks=False):
        for name in names:
            candidate = Path(directory, name)
            if name != "node-pty" or candidate.parent.name != "node_modules":
                continue
            candidate_snapshot = path_snapshot(candidate)
            if not (stat.S_ISDIR(candidate_snapshot[2]) or stat.S_ISLNK(candidate_snapshot[2])):
                raise SystemExit(f"node-pty package is not a directory or internal alias: {candidate}")
            root = require_inside_runtime(candidate)
            aliases.setdefault(root, []).append((candidate, candidate_snapshot))
    if not aliases:
        raise SystemExit(f"node-pty package is unavailable in the macOS runtime: {runtime}")
    roots = sorted(aliases)
    for index, root in enumerate(roots):
        for other in roots[index + 1:]:
            if root in other.parents or other in root.parents:
                raise SystemExit(f"node-pty physical package roots overlap: {root} and {other}")
    return tuple((root, tuple(sorted(aliases[root], key=lambda item: str(item[0])))) for root in roots)


def require_safe_path_chain(root: Path, path: Path, description: str) -> None:
    require_strict_descendant(path, root, description)
    current = root
    for part in path.relative_to(root).parts[:-1]:
        current /= part
        require_ordinary_directory(current, f"{description} parent directory")


def resolve_package_main(root: Path, manifest: dict[str, object]) -> Path:
    raw = manifest.get("main")
    if not isinstance(raw, str) or raw == "" or "\0" in raw or "\\" in raw:
        raise SystemExit(f"node-pty package main must be a non-empty relative POSIX path: {root / 'package.json'}")
    relative = Path(raw)
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"node-pty package main must not be absolute or contain '..': {raw}")
    parts = tuple(part for part in relative.parts if part not in ("", "."))
    if not parts:
        raise SystemExit(f"node-pty package main does not name a file: {raw}")
    main = root.joinpath(*parts)
    require_safe_path_chain(root, main, "portable JavaScript entry")
    require_ordinary_file(main, "portable JavaScript entry")
    try:
        resolved = main.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f"node-pty package main cannot be resolved: {main}: {error}") from error
    require_strict_descendant(resolved, root, "package main")
    if resolved != main:
        raise SystemExit(f"node-pty package main traverses a symlink: {main} -> {resolved}")
    return main


def require_arm64_macho(path: Path, description: str) -> None:
    require_ordinary_file(path, description)
    result = subprocess.run(
        ["/usr/bin/lipo", "-archs", str(path)],
        capture_output=True,
        check=False,
        text=True,
    )
    architectures = result.stdout.strip()
    if result.returncode != 0 or architectures != "arm64":
        detail = result.stderr.strip() or architectures or "unreadable Mach-O"
        raise SystemExit(f"node-pty {description} must be an arm64-only Mach-O: {path}: {detail}")


def lexists(path: Path) -> bool:
    return os.path.lexists(path)


def plan_delete(root: Path, path: Path, description: str) -> dict[str, object]:
    require_safe_path_chain(root, path, description)
    result = lstat(path, description)
    if not (stat.S_ISREG(result.st_mode) or stat.S_ISDIR(result.st_mode)):
        raise SystemExit(f"node-pty refuses to delete a link or special {description}: {path}")
    return {
        "path": path,
        "snapshot": path_snapshot(path),
        "tree": tree_snapshot(path, reject_links=True),
    }


def is_under_planned_delete(path: Path, planned: tuple[dict[str, object], ...]) -> bool:
    return any(path == item["path"] or item["path"] in path.parents for item in planned)


def inspect_package(root: Path, aliases: tuple[tuple[Path, tuple[object, ...]], ...]) -> dict[str, object]:
    manifest_path = root / "package.json"
    require_ordinary_file(manifest_path, "package manifest")
    try:
        manifest = json.loads(read_ordinary_text(manifest_path, "package manifest"))
        if not isinstance(manifest, dict) or manifest.get("name") != "node-pty":
            raise ValueError("package name mismatch")
    except (json.JSONDecodeError, OSError, ValueError) as error:
        raise SystemExit(f"node-pty has an invalid package manifest: {manifest_path}: {error}") from error
    main = resolve_package_main(root, manifest)

    prebuilds = root / "prebuilds"
    darwin = prebuilds / "darwin-arm64"
    require_ordinary_directory(prebuilds, "prebuilds directory")
    require_ordinary_directory(darwin, "darwin-arm64 payload directory")
    addon = darwin / "pty.node"
    helper = darwin / "spawn-helper"
    require_arm64_macho(addon, "darwin addon")
    require_arm64_macho(helper, "darwin spawn helper")
    if not os.access(helper, os.X_OK):
        raise SystemExit(f"node-pty darwin spawn helper is not executable: {helper}")

    foreign_prebuilds = tuple(sorted(path.name for path in prebuilds.iterdir() if path.name != "darwin-arm64"))
    planned_list: list[dict[str, object]] = []
    for name in foreign_prebuilds:
        planned_list.append(plan_delete(root, prebuilds / name, "foreign prebuild payload"))
    conpty = root / "third_party" / "conpty"
    if lexists(conpty):
        planned_list.append(plan_delete(root, conpty, "Windows ConPTY payload"))
    build = root / "build"
    if lexists(build):
        planned_list.append(plan_delete(root, build, "unlabelled native build payload"))
    planned = tuple(planned_list)

    allowed_native_root = darwin.resolve(strict=True)
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        current = Path(directory)
        retained_names: list[str] = []
        for name in sorted(names):
            path = current / name
            if is_under_planned_delete(path, planned):
                continue
            result = lstat(path, "package directory")
            if not stat.S_ISDIR(result.st_mode):
                raise SystemExit(f"node-pty package contains a symlink or special directory: {path}")
            retained_names.append(name)
        names[:] = retained_names
        for name in sorted(files):
            payload = current / name
            if is_under_planned_delete(payload, planned):
                continue
            require_ordinary_file(payload, "package file")
            lower_name = payload.name.lower()
            if lower_name.endswith((".exe", ".dll", ".pdb")):
                raise SystemExit(f"node-pty retains a Windows native payload: {payload}")
            if lower_name.endswith(".node") or lower_name == "spawn-helper":
                resolved = payload.resolve(strict=True)
                try:
                    resolved.relative_to(allowed_native_root)
                except ValueError as error:
                    raise SystemExit(f"node-pty native payload is outside darwin-arm64: {payload}") from error

    critical_paths = (root, manifest_path, main, prebuilds, darwin, addon, helper)
    return {
        "root": root,
        "aliases": aliases,
        "foreign_prebuilds": foreign_prebuilds,
        "has_conpty": lexists(conpty),
        "has_build": lexists(build),
        "planned": planned,
        "critical": tuple((path, path_snapshot(path)) for path in critical_paths),
        "tree": tree_snapshot(root, reject_links=True),
    }


def assert_snapshot(path: Path, expected: tuple[object, ...], description: str) -> None:
    actual = path_snapshot(path)
    if actual != expected:
        raise SystemExit(f"node-pty {description} changed between preflight and mutation: {path}")


discovery = discover_packages()
records = tuple(inspect_package(root, aliases) for root, aliases in discovery)

if action == "check":
    for record in records:
        if record["foreign_prebuilds"]:
            raise SystemExit(
                f"node-pty retains foreign prebuilds in {record['root']}: {list(record['foreign_prebuilds'])}"
            )
        if record["has_conpty"]:
            raise SystemExit(f"node-pty retains a Windows ConPTY payload: {record['root']}")
        if record["has_build"]:
            raise SystemExit(f"node-pty retains an unlabelled native build payload: {record['root']}")

if action == "prune":
    if any(stat.S_ISDIR(item["snapshot"][2]) for record in records for item in record["planned"]):
        if not shutil.rmtree.avoids_symlink_attacks:
            raise SystemExit("node-pty requires symlink-safe recursive deletion on this platform")

    # Re-discover every alias and compare complete package trees immediately
    # before the first mutation. Any failed copy leaves every copy untouched.
    if discover_packages() != discovery:
        raise SystemExit("node-pty package discovery changed between preflight and mutation")
    for record in records:
        root = record["root"]
        for alias, expected in record["aliases"]:
            assert_snapshot(alias, expected, "package alias")
        if tree_snapshot(root, reject_links=True) != record["tree"]:
            raise SystemExit(f"node-pty package tree changed between preflight and mutation: {root}")
        for path, expected in record["critical"]:
            assert_snapshot(path, expected, "critical path")
        for item in record["planned"]:
            path = item["path"]
            assert_snapshot(path, item["snapshot"], "planned payload")
            if tree_snapshot(path, reject_links=True) != item["tree"]:
                raise SystemExit(f"node-pty planned payload changed between preflight and mutation: {path}")

    for record in records:
        root = record["root"]
        root_identity = path_snapshot(root)[:3]
        for item in record["planned"]:
            path = item["path"]
            if path_snapshot(root)[:3] != root_identity:
                raise SystemExit(f"node-pty package root changed during mutation: {root}")
            require_safe_path_chain(root, path, "planned payload")
            assert_snapshot(path, item["snapshot"], "planned payload")
            mode = item["snapshot"][2]
            if stat.S_ISDIR(mode):
                shutil.rmtree(path)
            else:
                path.unlink()

    # The same inspector now represents the real postcondition. It must have
    # no remaining deletion plan because every possible failure was modelled
    # before the transaction boundary.
    post_records = tuple(inspect_package(root, aliases) for root, aliases in discover_packages())
    for record in post_records:
        if record["planned"]:
            raise SystemExit(f"node-pty postcondition retains removable payloads: {record['root']}")

print(f"node-pty macOS arm64 {action} accepted {len(records)} physical package copies")
PYTHON
}

function ark_adapt_swiftmath_checkout() {
  local checkout="${1}"
  [[ "${checkout}" == /* && -d "${checkout}" && ! -L "${checkout}" ]] || {
    print -u2 "SwiftMath checkout must be an absolute ordinary directory: ${checkout}"
    return 2
  }

  local mt_font="${checkout}/Sources/SwiftMath/MathRender/MTFont.swift"
  local math_font="${checkout}/Sources/SwiftMath/MathBundle/MathFont.swift"
  local source
  for source in "${mt_font}" "${math_font}"; do
    [[ -f "${source}" && ! -L "${source}" ]] || {
      print -u2 "SwiftMath packaging source is unavailable or link-shaped: ${source}"
      return 2
    }
  done

  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  [[ -x "${python}" ]] || {
    print -u2 "Python 3 is unavailable for the SwiftMath packaging adapter"
    return 2
  }
  chmod u+w "${mt_font}" "${math_font}"
  "${python}" - "${checkout}" <<'PYTHON'
from pathlib import Path
import sys

checkout = Path(sys.argv[1])
mt_font = checkout / "Sources/SwiftMath/MathRender/MTFont.swift"
math_font = checkout / "Sources/SwiftMath/MathBundle/MathFont.swift"

mt_source = mt_font.read_text()
old_bundle = 'Bundle(url: Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")!)!'
new_bundle = 'Bundle(url: arkSwiftMathBundle().url(forResource: "mathFonts", withExtension: "bundle")!)!'
helper_anchor = "public class MTFont {"
helper_name = "func arkSwiftMathBundle()"
helper = '''func arkSwiftMathBundle() -> Bundle {
#if os(macOS)
    let bundleName = "SwiftMath_SwiftMath.bundle"
    let candidates = [
        Bundle.main.resourceURL?.appendingPathComponent(bundleName),
        Bundle.main.bundleURL.appendingPathComponent(bundleName),
    ]
    for candidate in candidates.compactMap({ $0 }) {
        if let bundle = Bundle(url: candidate) {
            return bundle
        }
    }
    Swift.fatalError("could not load SwiftMath resource bundle")
#else
    return Bundle.module
#endif
}

public class MTFont {'''

math_source = math_font.read_text()
old_lookup = 'Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")'
new_lookup = 'arkSwiftMathBundle().url(forResource: "mathFonts", withExtension: "bundle")'

# Validate the complete pinned-source input before changing either file. An
# already-adapted or partially adapted checkout is indistinguishable from
# upstream anchor drift and must not pass a candidate build.
if mt_source.count(old_bundle) != 1:
    raise SystemExit("SwiftMath MTFont resource anchor drifted")
if mt_source.count(helper_anchor) != 1 or mt_source.count(helper_name) != 0 or mt_source.count(new_bundle) != 0:
    raise SystemExit("SwiftMath MTFont helper anchor drifted")
if math_source.count(old_lookup) != 2 or math_source.count(new_lookup) != 0:
    raise SystemExit("SwiftMath MathFont resource anchors drifted")

adapted_mt = mt_source.replace(old_bundle, new_bundle, 1).replace(helper_anchor, helper, 1)
adapted_math = math_source.replace(old_lookup, new_lookup, 2)
if adapted_mt.count(old_bundle) != 0 or adapted_mt.count(new_bundle) != 1 or adapted_mt.count(helper_name) != 1:
    raise SystemExit("SwiftMath MTFont packaging adapter produced an invalid result")
if adapted_math.count(old_lookup) != 0 or adapted_math.count(new_lookup) != 2:
    raise SystemExit("SwiftMath MathFont packaging adapter produced an invalid result")

mt_font.write_text(adapted_mt)
math_font.write_text(adapted_math)
print("SwiftMath packaging adapter replaced MTFont=1 MathFont=2 anchors")
PYTHON
}

function ark_tree_manifest() {
  local tree_root="${1}"
  local output="${2}"
  local label="${3}"
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  "${python}" - "${tree_root}" "${output}" "${label}" <<'PYTHON' || return 2
from pathlib import Path
import hashlib
import json
import os
import stat
import sys

root = Path(sys.argv[1]).resolve(strict=True)
output = Path(sys.argv[2])
label = sys.argv[3]
if not root.is_dir() or root.is_symlink():
    raise SystemExit(f"tree manifest root is not an ordinary directory: {root}")
entries = []
for directory, names, files in os.walk(root, followlinks=False):
    names.sort()
    files.sort()
    for name in [*names, *files]:
        path = Path(directory, name)
        relative = path.relative_to(root).as_posix()
        identity = path.lstat()
        mode = stat.S_IMODE(identity.st_mode)
        if path.is_symlink():
            target = path.resolve(strict=True)
            try:
                target_relative = target.relative_to(root).as_posix()
            except ValueError as error:
                raise SystemExit(f"tree manifest found escaping symlink: {path}") from error
            entries.append({"path": relative, "kind": "link", "mode": mode, "target": target_relative})
        elif path.is_file():
            entries.append({
                "path": relative,
                "kind": "file",
                "mode": mode,
                "size": identity.st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            })
        elif path.is_dir():
            entries.append({"path": relative, "kind": "directory", "mode": mode})
        else:
            raise SystemExit(f"tree manifest found special file: {path}")
payload = {"version": 1, "label": label, "entries": entries}
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
payload["treeSha256"] = hashlib.sha256(canonical).hexdigest()
output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PYTHON
}

function ark_native_source_manifest() {
  local output="${1}"
  local receipt_path="${2}"
  local node_path="${3}"
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  "${python}" - "${native_root}" "${receipt_path}" "${node_path}" "${output}" <<'PYTHON' || return 2
from pathlib import Path
import hashlib
import json
import os
import sys

root = Path(sys.argv[1]).resolve(strict=True)
receipt = Path(sys.argv[2]).resolve(strict=True)
node = Path(sys.argv[3]).resolve(strict=True)
output = Path(sys.argv[4])
inputs = [root / "Package.swift", root / "Package.resolved", root / "build-app.sh", root / "candidate-data.mjs"]
for subtree in (root / "Sources", root / "Resources"):
    for directory, names, files in os.walk(subtree, followlinks=False):
        names[:] = sorted(name for name in names if not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            path = Path(directory, name)
            if path.is_symlink() or not path.is_file():
                raise SystemExit(f"native source input is not an ordinary file: {path}")
            inputs.append(path)
records = []
for path in sorted(set(inputs)):
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"native source input is unavailable: {path}")
    records.append({
        "path": path.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    })
records.append({"path": "<source-anchor>", "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest()})
records.append({"path": "<embedded-node-input>", "sha256": hashlib.sha256(node.read_bytes()).hexdigest()})
payload = {"version": 1, "inputs": records}
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
payload["sourceInputsSha256"] = hashlib.sha256(canonical).hexdigest()
output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PYTHON
}

function ark_macho_inventory() {
  local tree_root="${1}"
  local phase="${2}"
  local output="${3}"
  local target_arch="${4:-arm64}"
  [[ "${phase}" == "pre-sign" || "${phase}" == "final" ]] || {
    print -u2 "Mach-O inventory phase must be pre-sign or final"
    return 2
  }
  for tool in /usr/bin/file /usr/bin/lipo /usr/bin/otool /usr/bin/codesign; do
    [[ -x "${tool}" ]] || { print -u2 "required Mach-O inventory tool is unavailable: ${tool}"; return 2; }
  done
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  "${python}" - "${tree_root}" "${phase}" "${output}" "${target_arch}" <<'PYTHON' || return 2
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys

root = Path(sys.argv[1]).resolve(strict=True)
phase = sys.argv[2]
output = Path(sys.argv[3])
target = sys.argv[4]
records = []
for directory, names, files in os.walk(root, followlinks=False):
    names[:] = sorted(name for name in names if not (Path(directory) / name).is_symlink())
    for name in sorted(files):
        path = Path(directory, name)
        if path.is_symlink() or not path.is_file():
            continue
        kind = subprocess.run(
            ["/usr/bin/file", "-b", str(path)], check=True, capture_output=True, text=True,
        ).stdout.strip()
        if "Mach-O" not in kind:
            continue
        architecture = subprocess.run(
            ["/usr/bin/lipo", "-archs", str(path)], check=True, capture_output=True, text=True,
        ).stdout.strip().split()
        if architecture != [target]:
            raise SystemExit(
                f"Mach-O must contain exactly {target}: {path.relative_to(root)}: {' '.join(architecture)}"
            )
        loads_output = subprocess.run(
            ["/usr/bin/otool", "-L", str(path)], check=True, capture_output=True, text=True,
        ).stdout.splitlines()[1:]
        loads = [line.strip().split(" (compatibility version", 1)[0] for line in loads_output if line.strip()]
        commands = subprocess.run(
            ["/usr/bin/otool", "-l", str(path)], check=True, capture_output=True, text=True,
        ).stdout.splitlines()
        rpaths = []
        pending_rpath = False
        for raw in commands:
            line = raw.strip()
            if line == "cmd LC_RPATH":
                pending_rpath = True
            elif pending_rpath and line.startswith("path "):
                match = re.fullmatch(r"path (.+) \(offset [0-9]+\)", line)
                if match is None:
                    raise SystemExit(f"unparsable RPATH: {path}: {line}")
                rpaths.append(match.group(1))
                pending_rpath = False
        record = {
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "architectures": architecture,
            "loads": loads,
            "rpaths": rpaths,
        }
        if phase == "final":
            display = subprocess.run(
                ["/usr/bin/codesign", "-d", "--verbose=4", str(path)], capture_output=True, text=True,
            )
            if display.returncode != 0:
                raise SystemExit(f"unsigned nested Mach-O: {path}: {display.stderr.strip()}")
            entitlements = subprocess.run(
                ["/usr/bin/codesign", "-d", "--entitlements", ":-", str(path)], capture_output=True, text=True,
            )
            if entitlements.returncode != 0:
                raise SystemExit(f"cannot read nested entitlements: {path}: {entitlements.stderr.strip()}")
            requirement = subprocess.run(
                ["/usr/bin/codesign", "-d", "-r-", str(path)], capture_output=True, text=True,
            )
            if requirement.returncode != 0:
                raise SystemExit(f"cannot read designated requirement: {path}: {requirement.stderr.strip()}")
            record["signature"] = display.stderr.strip()
            record["entitlements"] = (entitlements.stdout + entitlements.stderr).strip()
            record["designatedRequirement"] = requirement.stderr.strip()
        records.append(record)
payload = {"version": 1, "phase": phase, "targetArchitecture": target, "machOCount": len(records), "files": records}
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
payload["inventorySha256"] = hashlib.sha256(canonical).hexdigest()
output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PYTHON
}

function ark_validate_signing_configuration() {
  local identity="${1}"
  local team_id="${2}"
  [[ "${identity}" == "Developer ID Application: "* ]] || {
    print -u2 "release signing identity must begin with 'Developer ID Application: '"
    return 2
  }
  [[ "${team_id}" =~ '^[A-Z0-9]{10}$' ]] || {
    print -u2 "JIUZHANG_TEAM_ID must be the exact 10-character Apple Team ID"
    return 2
  }
}

function ark_reject_runtime_hardlinks() {
  local candidate_runtime="${1}"
  local python="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
  "${python}" - "${candidate_runtime}" <<'PYTHON' || return 2
from pathlib import Path
import os
import sys

root = Path(sys.argv[1]).resolve(strict=True)
modules = root / "node_modules"
for directory, names, files in os.walk(modules, followlinks=False):
    names[:] = [name for name in names if not (Path(directory) / name).is_symlink()]
    for name in files:
        path = Path(directory, name)
        if path.is_symlink() or not path.is_file():
            continue
        links = path.stat().st_nlink
        if links != 1:
            raise SystemExit(f"Ark runtime contains an external hardlinked file: {path} (nlink={links})")
PYTHON
}

function ark_assert_signed_identity() {
  local candidate="${1}"
  local identity="${2}"
  local team_id="${3}"
  local details
  details="$(/usr/bin/codesign -d --verbose=4 "${candidate}" 2>&1)" || return 2
  print -r -- "${details}" | /usr/bin/grep -Fq "Authority=${identity}" || {
    print -u2 "signed Ark authority does not match the configured Developer ID identity"
    return 2
  }
  print -r -- "${details}" | /usr/bin/grep -Fq "TeamIdentifier=${team_id}" || {
    print -u2 "signed Ark TeamIdentifier does not match JIUZHANG_TEAM_ID"
    return 2
  }
}

case "${1:-}" in
  --check-candidate-data)
    [[ "${#}" == 1 ]] || { print -u2 "usage: build-app.sh --check-candidate-data"; exit 2; }
    "${JIUZHANG_NODE_EXECUTABLE:-$(command -v node)}" "${native_root}/candidate-data.mjs" plan
    exit $?
    ;;
  --check-output)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --check-output /absolute/candidate-directory"; exit 2; }
    ark_refuse_unsafe_output "${2}" >/dev/null
    print -r -- "safe Ark candidate output: ${2:A}"
    exit 0
    ;;
  --check-candidate)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --check-candidate /absolute/Ark.app"; exit 2; }
    candidate="$(ark_refuse_unsafe_candidate "${2}")"
    ark_main_swift_rpaths check "${candidate}/Contents/MacOS/Ark"
    print -r -- "safe Ark candidate: ${2:A}"
    exit 0
    ;;
  --check-main-swift-rpaths)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --check-main-swift-rpaths /absolute/Mach-O"; exit 2; }
    ark_main_swift_rpaths check "${2}"
    exit 0
    ;;
  --normalize-main-swift-rpaths)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --normalize-main-swift-rpaths /absolute/Mach-O"; exit 2; }
    ark_main_swift_rpaths prune "${2}"
    exit 0
    ;;
  --check-runtime-compatibility)
    [[ "${#}" == 3 ]] || { print -u2 "usage: build-app.sh --check-runtime-compatibility ArkSettingsAPI.swift /runtime/root"; exit 2; }
    ark_require_runtime_compatibility "${2}" "${3}"
    print -r -- "compatible Native Provider client and Host runtime"
    exit 0
    ;;
  --check-node-pty-macos-arm64)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --check-node-pty-macos-arm64 /absolute/runtime/root"; exit 2; }
    ark_node_pty_macos_arm64 check "${2}"
    exit 0
    ;;
  --check-runtime-browser-assets)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --check-runtime-browser-assets /absolute/runtime/root"; exit 2; }
    ark_runtime_browser_assets check "${2}"
    exit 0
    ;;
  --check-runtime-install-state)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --check-runtime-install-state /absolute/runtime/root"; exit 2; }
    ark_runtime_install_state check "${2}"
    exit 0
    ;;
  --prune-runtime-install-state)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --prune-runtime-install-state /absolute/runtime/root"; exit 2; }
    ark_runtime_install_state prune "${2}"
    exit 0
    ;;
  --preflight-runtime-browser-assets)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --preflight-runtime-browser-assets /absolute/runtime/root"; exit 2; }
    ark_runtime_browser_assets preflight "${2}"
    exit 0
    ;;
  --normalize-runtime-macho-ids)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --normalize-runtime-macho-ids /absolute/runtime/root"; exit 2; }
    ark_normalize_runtime_macho_ids "${2}"
    exit 0
    ;;
  --prune-runtime-browser-assets)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --prune-runtime-browser-assets /absolute/runtime/root"; exit 2; }
    ark_runtime_browser_assets prune "${2}"
    exit 0
    ;;
  --prune-node-pty-macos-arm64)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --prune-node-pty-macos-arm64 /absolute/runtime/root"; exit 2; }
    ark_node_pty_macos_arm64 prune "${2}"
    exit 0
    ;;
  --adapt-swiftmath-checkout)
    [[ "${#}" == 2 ]] || { print -u2 "usage: build-app.sh --adapt-swiftmath-checkout /absolute/SwiftMath-checkout"; exit 2; }
    ark_adapt_swiftmath_checkout "${2}"
    exit 0
    ;;
  --audit-macho-tree)
    [[ "${#}" == 4 ]] || { print -u2 "usage: build-app.sh --audit-macho-tree /absolute/tree pre-sign|final /absolute/output.json"; exit 2; }
    ark_macho_inventory "${2}" "${3}" "${4}" arm64
    exit 0
    ;;
  --check-signing-config)
    [[ "${#}" == 3 ]] || { print -u2 "usage: build-app.sh --check-signing-config 'Developer ID Application: …' TEAMID"; exit 2; }
    ark_validate_signing_configuration "${2}" "${3}"
    print -r -- "valid Developer ID Application identity and Team ID"
    exit 0
    ;;
  --check-signed-identity)
    [[ "${#}" == 4 ]] || { print -u2 "usage: build-app.sh --check-signed-identity /absolute/app-or-binary 'Developer ID Application: …' TEAMID"; exit 2; }
    ark_validate_signing_configuration "${3}" "${4}"
    ark_assert_signed_identity "${2}" "${3}" "${4}"
    print -r -- "signed identity and Team ID match"
    exit 0
    ;;
esac

destination="$(ark_refuse_unsafe_output "${1:-/private/tmp/jiuzhang-native-output}")"
node_executable="${JIUZHANG_NODE_EXECUTABLE:-$(command -v node)}"
if [[ -n "${JIUZHANG_RUNTIME_ROOT:-}" ]]; then
  [[ "${JIUZHANG_RUNTIME_ROOT}" == /* ]] || {
    print -u2 "JIUZHANG_RUNTIME_ROOT must be an absolute path"
    exit 2
  }
  [[ -d "${JIUZHANG_RUNTIME_ROOT}" && ! -L "${JIUZHANG_RUNTIME_ROOT}" ]] || {
    print -u2 "JIUZHANG_RUNTIME_ROOT must be an existing ordinary directory: ${JIUZHANG_RUNTIME_ROOT}"
    exit 2
  }
  runtime_root="${JIUZHANG_RUNTIME_ROOT:A}"
  launcher_path="${runtime_root}/start.mjs"
  built_runner="${runtime_root}/node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js"
fi
if [[ "${JIUZHANG_SELF_CONTAINED:-}" == 1 ]]; then
  [[ -n "${JIUZHANG_RUNTIME_ROOT:-}" ]] || {
    print -u2 "JIUZHANG_SELF_CONTAINED=1 requires JIUZHANG_RUNTIME_ROOT (a standalone runtime directory)"
    exit 2
  }
  [[ -n "${JIUZHANG_PACK_RECEIPT:-}" ]] || {
    print -u2 "JIUZHANG_SELF_CONTAINED=1 requires JIUZHANG_PACK_RECEIPT from pack-runtime.mjs"
    exit 2
  }
fi
[[ -x "${node_executable}" ]] || { print -u2 "Node.js executable is unavailable: ${node_executable}"; exit 2; }
"${node_executable}" "${native_root}/candidate-data.mjs" plan >/dev/null
node_version="$("${node_executable}" -p 'process.versions.node' 2>/dev/null)" || {
  print -u2 "Unable to read the selected Node.js version: ${node_executable}"
  exit 2
}
[[ "${node_version}" == <->.<->.<->* ]] || { print -u2 "Invalid Node.js version: ${node_version}"; exit 2; }
node_version_parts=("${(@s:.:)node_version}")
node_major="${node_version_parts[1]}"
node_minor="${node_version_parts[2]}"
(( node_major == 22 && node_minor >= 19 || node_major >= 24 )) || {
  print -u2 "Node.js ${node_version} is unsupported; use ^22.19.0 or >=24.0.0"
  exit 2
}
if [[ "${JIUZHANG_SELF_CONTAINED:-}" != 1 ]]; then
  [[ -f "${launcher_path}" && -r "${launcher_path}" ]] || { print -u2 "Jiuzhang launcher is unavailable: ${launcher_path}"; exit 2; }
  [[ -f "${built_runner}" && -r "${built_runner}" ]] || { print -u2 "Native API runner is unavailable: ${built_runner}"; exit 2; }
fi
[[ -r "${icon_source}" ]] || { print -u2 "Jiuzhang icon source is unavailable: ${icon_source}"; exit 2; }

for required_tool in /usr/bin/sips /usr/bin/plutil /usr/bin/codesign /usr/bin/strip; do
  [[ -x "${required_tool}" ]] || { print -u2 "Required macOS tool is unavailable: ${required_tool}"; exit 2; }
done
python_executable="${JIUZHANG_PYTHON_EXECUTABLE:-$(command -v python3)}"
[[ -x "${python_executable}" ]] || { print -u2 "Python 3 is unavailable: ${python_executable}"; exit 2; }
"${python_executable}" -c 'from PIL import Image' >/dev/null 2>&1 || {
  print -u2 "Pillow is unavailable to the selected Python 3: ${python_executable}"
  exit 2
}

final_app_path="${destination}/Ark.app"
scratch="$(mktemp -d /private/tmp/jiuzhang-native-build.XXXXXX)"
build_stage_root=""
swiftmath_mt_font_backup=""
swiftmath_math_font_backup=""
function ark_cleanup_build() {
  if [[ -n "${swiftmath_mt_font_backup}" && -f "${swiftmath_mt_font_backup}" ]]; then
    /bin/cp -p "${swiftmath_mt_font_backup}" "${swiftmath_checkout}/Sources/SwiftMath/MathRender/MTFont.swift"
  fi
  if [[ -n "${swiftmath_math_font_backup}" && -f "${swiftmath_math_font_backup}" ]]; then
    /bin/cp -p "${swiftmath_math_font_backup}" "${swiftmath_checkout}/Sources/SwiftMath/MathBundle/MathFont.swift"
  fi
  /bin/rm -rf -- "${scratch}"
  if [[ -n "${build_stage_root}" && -d "${build_stage_root}" ]]; then
    /bin/rm -rf -- "${build_stage_root}"
  fi
}
trap ark_cleanup_build EXIT

# Offline release builds may provide an already-resolved SwiftPM scratch tree.
# Keep the default isolated scratch directory, while accepting an explicit
# ordinary directory so a network outage does not force a dependency re-clone.
swift_scratch="${JIUZHANG_SWIFT_SCRATCH_PATH:-${scratch}/swift}"
if [[ -n "${JIUZHANG_SWIFT_SCRATCH_PATH:-}" ]]; then
  [[ "${swift_scratch}" == /* && ! -L "${swift_scratch}" ]] || {
    print -u2 "JIUZHANG_SWIFT_SCRATCH_PATH must be an absolute ordinary directory"
    exit 2
  }
  mkdir -p "${swift_scratch}"
fi

ark_refuse_unsafe_output "${destination}" >/dev/null
build_stage_root="$(mktemp -d "${destination:h}/.${destination:t}.staging.XXXXXX")"
app_path="${build_stage_root}/Ark.app"
effective_pack_receipt=""
staged_pack_root=""
if [[ "${JIUZHANG_SELF_CONTAINED:-}" == 1 ]]; then
  external_runtime_root="${runtime_root}"
  external_pack_receipt="${JIUZHANG_PACK_RECEIPT:A}"
  external_pack_root="${external_pack_receipt:h}"
  [[ "${destination}" != "${external_pack_root}" && "${destination}" != ${external_pack_root}/* \
    && "${external_pack_root}" != ${destination}/* ]] || {
    print -u2 "Ark candidate output and runtime pack must be disjoint"
    exit 2
  }
  runtime_relative="$("${node_executable}" -e \
    'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtimeRelativePath; if(typeof value!=="string"||value===""||value.startsWith("/")||value.split("/").includes("..")) process.exit(2); process.stdout.write(value)' \
    "${external_pack_receipt}")" || {
    print -u2 "Ark pack receipt has an invalid runtimeRelativePath"
    exit 2
  }
  bound_external_runtime="${external_pack_root}/${runtime_relative}"
  bound_external_runtime="${bound_external_runtime:A}"
  [[ "${bound_external_runtime}" == "${external_runtime_root}" ]] || {
    print -u2 "JIUZHANG_RUNTIME_ROOT is not the runtime bound by JIUZHANG_PACK_RECEIPT"
    exit 2
  }
  ark_reject_runtime_hardlinks "${external_runtime_root}"
  staged_pack_root="${build_stage_root}/pack-input"
  /usr/bin/ditto "${external_pack_root}" "${staged_pack_root}"
  effective_pack_receipt="${staged_pack_root}/pack-receipt.json"
  runtime_root="${staged_pack_root}/${runtime_relative}"
  runtime_root="${runtime_root:A}"
  launcher_path="${runtime_root}/start.mjs"
  built_runner="${runtime_root}/node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js"
  ark_require_pack_receipt "${runtime_root}" "${effective_pack_receipt}" "${node_executable}"
  ark_require_runtime_compatibility \
    "${native_root}/Sources/JiuzhangShellCore/ArkSettingsAPI.swift" \
    "${runtime_root}"
  ark_runtime_browser_assets preflight "${runtime_root}"
fi
native_source_before_path="${scratch}/native-source-inputs-before.json"
source_anchor_path="${effective_pack_receipt:-${repository_root}/pnpm-lock.yaml}"
ark_native_source_manifest "${native_source_before_path}" "${source_anchor_path}" "${node_executable}"

export CLANG_MODULE_CACHE_PATH="${scratch}/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="${scratch}/swift-cache"

icon_master="${scratch}/AppIcon-1024.png"
icon_width="$(/usr/bin/sips -g pixelWidth "${icon_source}" | awk '/pixelWidth/ { print $2 }')"
icon_height="$(/usr/bin/sips -g pixelHeight "${icon_source}" | awk '/pixelHeight/ { print $2 }')"
[[ "${icon_width}" == 1024 && "${icon_height}" == 1024 ]] || {
  print -u2 "Ark seal icon source must be exactly 1024x1024 pixels."
  exit 2
}
install -m 0644 "${icon_source}" "${icon_master}"

icon_preview="${scratch}/AppIcon-128.png"
/usr/bin/sips -z 128 128 "${icon_master}" --out "${icon_preview}" >/dev/null
[[ "$(/usr/bin/sips -g pixelWidth "${icon_preview}" | awk '/pixelWidth/ { print $2 }')" == 128 ]] || {
  print -u2 "Unable to verify the Jiuzhang icon preview."
  exit 2
}
"${python_executable}" - "${icon_master}" "${scratch}/AppIcon.icns" <<'PYTHON'
from pathlib import Path
import sys

from PIL import Image

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
with Image.open(source) as image:
    image.save(
        destination,
        format="ICNS",
        sizes=[
            (16, 16),
            (32, 32),
            (64, 64),
            (128, 128),
            (256, 256),
            (512, 512),
            (1024, 1024),
        ],
    )
PYTHON
/usr/bin/iconutil --convert iconset "${scratch}/AppIcon.icns" --output "${scratch}/AppIcon-verify.iconset"

# SwiftPM's generated executable accessor looks beside Bundle.main.bundleURL,
# which is outside a macOS app's sealed Contents tree. Resolve the exact pinned
# checkout first, then apply Ark's narrow packaging adapter so SwiftMath loads
# its font bundle from Contents/Resources in packaged apps while retaining
# Bundle.module for ordinary development/test builds. Every replacement is
# count-checked and fails closed if the pinned upstream source drifts.
swift package resolve \
  --disable-sandbox \
  --package-path "${native_root}" \
  --scratch-path "${swift_scratch}"
swiftmath_checkout="${swift_scratch}/checkouts/SwiftMath"
[[ -d "${swiftmath_checkout}" ]] || {
  print -u2 "Pinned SwiftMath checkout is unavailable"
  exit 2
}
swiftmath_mt_font_backup="${scratch}/SwiftMath-MTFont.swift"
swiftmath_math_font_backup="${scratch}/SwiftMath-MathFont.swift"
/bin/cp -p "${swiftmath_checkout}/Sources/SwiftMath/MathRender/MTFont.swift" "${swiftmath_mt_font_backup}"
/bin/cp -p "${swiftmath_checkout}/Sources/SwiftMath/MathBundle/MathFont.swift" "${swiftmath_math_font_backup}"
ark_adapt_swiftmath_checkout "${swiftmath_checkout}"

swift build \
  --disable-sandbox \
  --package-path "${native_root}" \
  --scratch-path "${swift_scratch}" \
  --configuration release \
  --product JiuzhangShell

binary_path="$(swift build \
  --disable-sandbox \
  --package-path "${native_root}" \
  --scratch-path "${swift_scratch}" \
  --configuration release \
  --show-bin-path)/JiuzhangShell"

# A packaged macOS build must resolve SwiftMath only from bundle-relative
# locations. If SwiftPM's generated absolute build fallback remains reachable,
# its temporary path survives in the release Mach-O and the candidate is not
# relocatable.
"${python_executable}" - "${binary_path}" <<'PYTHON'
from pathlib import Path
import sys

binary = Path(sys.argv[1])
absolute_fallbacks = [
    value for value in binary.read_bytes().split(b"\0")
    if value.startswith(b"/") and value.endswith(b"SwiftMath_SwiftMath.bundle")
]
if absolute_fallbacks:
    rendered = "\n".join(value.decode("utf-8", errors="replace") for value in absolute_fallbacks)
    raise SystemExit(f"release binary retains an absolute SwiftMath resource fallback:\n{rendered}")
PYTHON

ark_refuse_unsafe_output "${destination}" >/dev/null
mkdir "${app_path}"
mkdir -p "${app_path}/Contents/MacOS" "${app_path}/Contents/Resources"
install -m 0755 "${binary_path}" "${app_path}/Contents/MacOS/Ark"
/usr/bin/strip -S -x "${app_path}/Contents/MacOS/Ark"
ark_main_swift_rpaths prune "${app_path}/Contents/MacOS/Ark"
"${python_executable}" - "${app_path}/Contents/MacOS/Ark" "${native_root}" "${swift_scratch}" <<'PYTHON'
from pathlib import Path
import sys

binary = Path(sys.argv[1])
payload = binary.read_bytes()
leaked_roots = [root for root in sys.argv[2:] if root.encode() in payload]
if leaked_roots:
    raise SystemExit(
        "release binary retains build-machine path after stripping:\n"
        + "\n".join(leaked_roots)
    )
PYTHON
install -m 0644 "${native_root}/Resources/Info.plist" "${app_path}/Contents/Info.plist"
"${node_executable}" "${native_root}/candidate-data.mjs" apply "${app_path}/Contents/Info.plist"
install -m 0644 "${scratch}/AppIcon.icns" "${app_path}/Contents/Resources/AppIcon.icns"
install -m 0644 "${wiki_background_source}" "${app_path}/Contents/Resources/WikiNeuralBackground.png"
"${node_executable}" "${native_root}/provider-icons.mjs" "${native_root}/Resources/ProviderIcons"
/usr/bin/ditto "${native_root}/Resources/ProviderIcons" "${app_path}/Contents/Resources/ProviderIcons"
"${node_executable}" "${native_root}/provider-icons.mjs" "${app_path}/Contents/Resources/ProviderIcons"

# The package adapter above resolves this bundle from the standard sealed
# Contents/Resources location in Ark.app.
swiftmath_bundle="$(find "${swift_scratch}" -type d -name 'SwiftMath_SwiftMath.bundle' 2>/dev/null | head -1)"
[[ -n "${swiftmath_bundle}" && -d "${swiftmath_bundle}" ]] || {
  print -u2 "SwiftMath resource bundle is unavailable after the release build"
  exit 2
}
/usr/bin/ditto "${swiftmath_bundle}" "${app_path}/Contents/Resources/SwiftMath_SwiftMath.bundle"

for localization in "${native_root}"/Resources/*.lproj; do
  [[ -d "${localization}" ]] || continue
  /usr/bin/ditto "${localization}" "${app_path}/Contents/Resources/${localization:t}"
done

# Self-contained distribution: embed the selected Node binary and the standalone
# runtime inside the bundle, recording bundle-relative paths in Info.plist.
if [[ "${JIUZHANG_SELF_CONTAINED:-}" == 1 ]]; then
  # Recompute the complete source plan again at the last point before the
  # staged runtime is copied into Ark.app and deterministically pruned.
  ark_require_pack_receipt "${runtime_root}" "${effective_pack_receipt}" "${node_executable}"
  mkdir -p "${app_path}/Contents/Resources/node/bin"
  install -m 0755 "${node_executable}" "${app_path}/Contents/Resources/node/bin/node"
  /usr/bin/ditto "${runtime_root}" "${app_path}/Contents/Resources/runtime"
  # pnpm normally uses relative links. A partially reconstructed store can
  # additionally contain hoist links whose absolute target is the link itself.
  # They are unusable even in the source tree and make codesign recurse forever.
  # Remove only those exact self-links from the embedded copy, then reject every
  # other absolute or escaping link so the bundle cannot secretly depend on the
  # build machine's workspace.
  "${python_executable}" - "${runtime_root}" "${app_path}/Contents/Resources/runtime" <<'PYTHON'
from pathlib import Path
import os
import shutil
import sys

source = Path(sys.argv[1]).resolve()
embedded = Path(sys.argv[2]).resolve()
for directory, names, files in os.walk(embedded, followlinks=False):
    for name in [*names, *files]:
        path = Path(directory, name)
        if not path.is_symlink():
            continue
        target = os.readlink(path)
        relative = path.relative_to(embedded)
        source_path = source / relative
        if os.path.isabs(target):
            if Path(target) == source_path:
                path.unlink()
                continue
            raise SystemExit(f"embedded runtime contains an absolute symlink: {path} -> {target}")
        lexical = Path(os.path.normpath(os.path.join(path.parent, target)))
        try:
            lexical.relative_to(embedded)
        except ValueError as error:
            raise SystemExit(f"embedded runtime symlink escapes the bundle: {path} -> {target}") from error

# The standalone closure is assembled for every supported platform. Ark.app
# is a macOS arm64 product, so retaining other operating-system/CPU payloads
# adds several gigabytes without providing a reachable code path. Keep each
# package's portable JS wrapper plus only its darwin-arm64 optional payload.
store = embedded / "node_modules" / ".pnpm"
platform_families = (
    "@anthropic-ai+claude-agent-sdk-",
    "@deepseek-ai+node-addon-landlock-run-",
    "@esbuild+",
    "@img+sharp-",
    "@img+sharp-libvips-",
    "@koromix+koffi-",
    "@napi-rs+canvas-",
    "@openai+codex@",
    "@rolldown+binding-",
    "@vscode+ripgrep-",
    "lightningcss-",
    "node-addon-require-builtin-",
)
if store.is_dir():
    for package in store.iterdir():
        name = package.name
        if not any(name.startswith(prefix) for prefix in platform_families):
            continue
        platform_markers = (
            "-aix-", "-android-", "-darwin-", "-freebsd-", "-linux",
            "-openbsd-", "-sunos-", "-win32-",
        )
        if not any(marker in name for marker in platform_markers):
            continue
        if "darwin-arm64" in name:
            continue
        shutil.rmtree(package)

# Optional-package links remain in the pnpm graph after their foreign-platform
# payload directory is removed. They are unreachable on this platform, but a
# dangling link still makes codesign's deep traversal fail. Remove only links
# whose lexical target no longer exists after the platform prune.
for directory, names, files in os.walk(embedded, followlinks=False):
    for name in [*names, *files]:
        path = Path(directory, name)
        if path.is_symlink() and not path.exists():
            path.unlink()
PYTHON
  ark_runtime_install_state prune "${app_path}/Contents/Resources/runtime"
  ark_runtime_browser_assets prune "${app_path}/Contents/Resources/runtime"
  ark_node_pty_macos_arm64 prune "${app_path}/Contents/Resources/runtime"
  ark_normalize_runtime_macho_ids "${app_path}/Contents/Resources/runtime"
  ark_require_runtime_compatibility \
    "${native_root}/Sources/JiuzhangShellCore/ArkSettingsAPI.swift" \
    "${app_path}/Contents/Resources/runtime"
  # Runtime documentation and executable bytes are immutable pack inputs.
  # Never refresh package files from the mutable checkout after receipt
  # verification; any documentation change must produce a new runtime pack.
  /usr/bin/plutil -replace JiuzhangNodeExecutable -string "Contents/Resources/node/bin/node" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -replace JiuzhangLauncherPath -string "Contents/Resources/runtime/start.mjs" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -replace JiuzhangRunnerPath -string "Contents/Resources/runtime/node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -replace JiuzhangRuntimeRoot -string "Contents/Resources/runtime" "${app_path}/Contents/Info.plist"
else
  /usr/bin/plutil -replace JiuzhangNodeExecutable -string "${node_executable}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -replace JiuzhangLauncherPath -string "${launcher_path}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -replace JiuzhangRunnerPath -string "${built_runner}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -replace JiuzhangRuntimeRoot -string "${runtime_root}" "${app_path}/Contents/Info.plist"
fi

# Seal the exact post-prune runtime and Native build inputs before signing.
# The installed manifest remains bound to the external pack receipt; this
# second manifest records the controlled platform/browser/install-state prune.
source_manifest_path="${scratch}/native-source-inputs.json"
pruned_runtime_manifest_path="${scratch}/pruned-runtime-manifest.json"
if [[ "${JIUZHANG_SELF_CONTAINED:-}" == 1 ]]; then
  "${app_path}/Contents/Resources/node/bin/node" \
    "${native_root:h}/src/runtime-closure.mjs" \
    "${app_path}/Contents/Resources/runtime" \
    "${native_root:h}/profile/forbidden-runtime-packages.json" \
    --node "${app_path}/Contents/Resources/node/bin/node" \
    --json \
    > "${pruned_runtime_manifest_path}"
  install -m 0644 "${pruned_runtime_manifest_path}" \
    "${app_path}/Contents/Resources/runtime/.ark-provenance/pruned-runtime-manifest.json"
  ark_native_source_manifest "${source_manifest_path}" "${effective_pack_receipt}" "${node_executable}"
else
  ark_native_source_manifest "${source_manifest_path}" "${repository_root}/pnpm-lock.yaml" "${node_executable}"
  print -r -- '{"version":1,"mode":"source-linked-development"}' > "${pruned_runtime_manifest_path}"
fi
/usr/bin/cmp -s "${native_source_before_path}" "${source_manifest_path}" || {
  print -u2 "Native source/build inputs changed while Ark.app was being built"
  exit 2
}
signed_provenance_path="${app_path}/Contents/Resources/ArkProvenance/source-and-pack.json"
mkdir -p "${signed_provenance_path:h}"
if [[ "${JIUZHANG_SELF_CONTAINED:-}" == 1 ]]; then
  install -m 0644 "${effective_pack_receipt}" "${signed_provenance_path:h}/pack-receipt.json"
  install -m 0644 "${staged_pack_root}/closure-plan.json" "${signed_provenance_path:h}/closure-plan.json"
  install -m 0644 "${source_manifest_path}" "${signed_provenance_path:h}/native-source-inputs.json"
  "${python_executable}" - \
    "${staged_pack_root}/closure-plan.json" \
    "${effective_pack_receipt}" \
    "${source_manifest_path}" \
    "${signed_provenance_path}" <<'PYTHON'
from pathlib import Path
import hashlib
import json
import sys

plan_path = Path(sys.argv[1])
receipt_path = Path(sys.argv[2])
native_source_path = Path(sys.argv[3])
output_path = Path(sys.argv[4])
plan = json.loads(plan_path.read_text())
identity = plan["sourceIdentity"]
payload = {
    "version": 1,
    "sourceIdentity": identity,
    "packReceiptSha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
    "nativeSourceInputsSha256": hashlib.sha256(native_source_path.read_bytes()).hexdigest(),
    "environmentFields": {
        "ARK_SOURCE_COMMIT": "ArkSourceCommit",
        "ARK_SOURCE_DIRTY_DIFF_SHA256": "ArkSourceDirtyDiffSHA256",
        "ARK_SOURCE_DIRTY_STATUS_SHA256": "ArkSourceDirtyStatusSHA256",
        "ARK_SOURCE_SNAPSHOT_SHA256": "ArkSourceSnapshotSHA256",
        "ARK_PACK_RECEIPT_SHA256": "ArkPackReceiptSHA256",
    },
}
output_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PYTHON
  source_commit="$("${node_executable}" -e 'const p=require(process.argv[1]);process.stdout.write(p.sourceIdentity.commit)' "${staged_pack_root}/closure-plan.json")"
  source_dirty_diff="$("${node_executable}" -e 'const p=require(process.argv[1]);process.stdout.write(p.sourceIdentity.dirtyDiffSha256)' "${staged_pack_root}/closure-plan.json")"
  source_dirty_status="$("${node_executable}" -e 'const p=require(process.argv[1]);process.stdout.write(p.sourceIdentity.dirtyStatusSha256)' "${staged_pack_root}/closure-plan.json")"
  source_snapshot="$("${node_executable}" -e 'const p=require(process.argv[1]);process.stdout.write(p.sourceIdentity.sourceSnapshotSha256)' "${staged_pack_root}/closure-plan.json")"
  pack_receipt_sha="$(/usr/bin/shasum -a 256 "${effective_pack_receipt}" | awk '{print $1}')"
  /usr/bin/plutil -insert ArkSourceCommit -string "${source_commit}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -insert ArkSourceDirtyDiffSHA256 -string "${source_dirty_diff}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -insert ArkSourceDirtyStatusSHA256 -string "${source_dirty_status}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -insert ArkSourceSnapshotSHA256 -string "${source_snapshot}" "${app_path}/Contents/Info.plist"
  /usr/bin/plutil -insert ArkPackReceiptSHA256 -string "${pack_receipt_sha}" "${app_path}/Contents/Info.plist"
else
  install -m 0644 "${source_manifest_path}" "${signed_provenance_path:h}/native-source-inputs.json"
  print -r -- '{"version":1,"mode":"source-linked-development"}' > "${signed_provenance_path}"
fi
pre_sign_tree_path="${scratch}/pre-sign-tree.json"
pre_sign_macho_path="${scratch}/pre-sign-macho.json"
ark_tree_manifest "${app_path}" "${pre_sign_tree_path}" "ark-app-pre-sign"
ark_macho_inventory "${app_path}" pre-sign "${pre_sign_macho_path}" arm64

# Signing: ad-hoc by default (local use), Developer ID when JIUZHANG_SIGN_IDENTITY is set.
sign_identity="${JIUZHANG_SIGN_IDENTITY:--}"
expected_team_id="${JIUZHANG_TEAM_ID:-}"
entitlements_path="${native_root}/Resources/ark.entitlements"
node_entitlements_path="${native_root}/Resources/node.entitlements"
[[ -r "${entitlements_path}" ]] || { print -u2 "Hardened-runtime entitlements are unavailable: ${entitlements_path}"; exit 2; }
[[ -r "${node_entitlements_path}" ]] || { print -u2 "Node entitlements are unavailable: ${node_entitlements_path}"; exit 2; }
if [[ "${sign_identity}" != "-" ]]; then
  ark_validate_signing_configuration "${sign_identity}" "${expected_team_id}"
  if ! /usr/bin/security find-identity -v -p codesigning 2>/dev/null | /usr/bin/grep -Fq "${sign_identity}"; then
    print -u2 "Signing identity '${sign_identity}' is not installed in the login keychain; install the Developer ID certificate first."
    exit 2
  fi
elif [[ -n "${expected_team_id}" ]]; then
  print -u2 "JIUZHANG_TEAM_ID cannot be used with ad-hoc signing"
  exit 2
fi
# Notarization requires a secure timestamp; ad-hoc local builds skip the network.
timestamp_flag="--timestamp=none"
[[ "${sign_identity}" != "-" ]] && timestamp_flag="--timestamp"
if [[ -x "${app_path}/Contents/Resources/node/bin/node" ]]; then
  /usr/bin/codesign --force --options runtime --entitlements "${node_entitlements_path}" --sign "${sign_identity}" "${timestamp_flag}" "${app_path}/Contents/Resources/node/bin/node"
fi
# --deep signs every nested executable (the embedded runtime's native addons
# included); the app seal is applied last over the finished bundle.
/usr/bin/codesign --force --deep --options runtime --entitlements "${entitlements_path}" --sign "${sign_identity}" "${timestamp_flag}" "${app_path}"
# The finished bundle must verify strictly before it is offered anywhere.
/usr/bin/codesign --verify --deep --strict "${app_path}"
if [[ "${sign_identity}" != "-" ]]; then
  ark_assert_signed_identity "${app_path}" "${sign_identity}" "${expected_team_id}"
fi
if [[ -x "${app_path}/Contents/Resources/node/bin/node" ]]; then
  "${app_path}/Contents/Resources/node/bin/node" -e "process.stdout.write('embedded-node-ok')" >/dev/null
fi

# Optional notarization: JIUZHANG_NOTARY_PROFILE names a stored notarytool
# keychain profile (Developer ID + App Store Connect API key). notarytool
# rejects a bare .app directory, so the bundle is archived first.
notary_receipt_path="${scratch}/notary-result.json"
notary_status="not-requested"
if [[ -n "${JIUZHANG_NOTARY_PROFILE:-}" ]]; then
  [[ "${sign_identity}" != "-" ]] || {
    print -u2 "Notarization requires a Developer ID signing identity"
    exit 2
  }
  notarization_archive="${scratch}/Ark-notarize.zip"
  /usr/bin/ditto -c -k --keepParent "${app_path}" "${notarization_archive}"
  /usr/bin/xcrun notarytool submit "${notarization_archive}" \
    --keychain-profile "${JIUZHANG_NOTARY_PROFILE}" --wait --output-format json \
    > "${notary_receipt_path}"
  /usr/bin/xcrun stapler staple "${app_path}"
  /usr/bin/xcrun stapler validate "${app_path}"
  notary_status="accepted-and-stapled"
fi

spctl_evidence_path="${scratch}/spctl.txt"
spctl_status="not-run-ad-hoc"
if [[ "${sign_identity}" != "-" ]]; then
  /usr/sbin/spctl --assess --type execute --verbose=4 "${app_path}" \
    > "${spctl_evidence_path}" 2>&1 || {
      print -u2 "Gatekeeper assessment rejected the Developer ID candidate"
      /bin/cat "${spctl_evidence_path}" >&2
      exit 2
    }
  spctl_status="accepted"
fi

final_tree_path="${scratch}/final-tree.json"
final_macho_path="${scratch}/final-macho.json"
ark_tree_manifest "${app_path}" "${final_tree_path}" "ark-app-final-signed"
ark_macho_inventory "${app_path}" final "${final_macho_path}" arm64

staged_receipt_path="${build_stage_root}/provenance.json"
"${python_executable}" - \
  "${source_manifest_path}" \
  "${pruned_runtime_manifest_path}" \
  "${pre_sign_tree_path}" \
  "${pre_sign_macho_path}" \
  "${final_tree_path}" \
  "${final_macho_path}" \
  "${effective_pack_receipt}" \
  "${signed_provenance_path}" \
  "${sign_identity}" \
  "${expected_team_id}" \
  "${notary_status}" \
  "${notary_receipt_path}" \
  "${spctl_status}" \
  "${spctl_evidence_path}" \
  "${staged_receipt_path}" <<'PYTHON'
from pathlib import Path
import hashlib
import json
import sys

# Keep argument decoding explicit so string signing identities are never
# interpreted as filesystem paths.
source_path = Path(sys.argv[1])
runtime_path = Path(sys.argv[2])
pre_tree_path = Path(sys.argv[3])
pre_macho_path = Path(sys.argv[4])
final_tree_path = Path(sys.argv[5])
final_macho_path = Path(sys.argv[6])
pack_receipt_path = sys.argv[7]
signed_provenance_path = Path(sys.argv[8])
sign_identity = sys.argv[9]
expected_team_id = sys.argv[10]
notary_status = sys.argv[11]
notary_path = Path(sys.argv[12])
spctl_status = sys.argv[13]
spctl_path = Path(sys.argv[14])
output_path = Path(sys.argv[15])

def load(path):
    return json.loads(path.read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

source = load(source_path)
runtime = load(runtime_path)
pre_tree = load(pre_tree_path)
pre_macho = load(pre_macho_path)
final_tree = load(final_tree_path)
final_macho = load(final_macho_path)
signed_provenance = load(signed_provenance_path)
pack_sha = digest(Path(pack_receipt_path)) if pack_receipt_path else None
notary = load(notary_path) if notary_path.is_file() else None
spctl = spctl_path.read_text() if spctl_path.is_file() else None
payload = {
    "version": 1,
    "target": "macos-arm64",
    "sourceInputsSha256": source["sourceInputsSha256"],
    "packReceiptSha256": pack_sha,
    "sourceIdentity": signed_provenance.get("sourceIdentity"),
    "signedSourceAndPackProvenanceSha256": digest(signed_provenance_path),
    "prunedRuntimeManifestSha256": digest(runtime_path),
    "preSignTreeSha256": pre_tree["treeSha256"],
    "preSignMachOInventorySha256": pre_macho["inventorySha256"],
    "finalTreeSha256": final_tree["treeSha256"],
    "finalMachOInventorySha256": final_macho["inventorySha256"],
    "manifests": {
        "sourceInputs": source,
        "prunedRuntime": runtime,
        "preSignTree": pre_tree,
        "preSignMachO": pre_macho,
        "finalTree": final_tree,
    },
    "signing": {
        "mode": "ad-hoc-test-only" if sign_identity == "-" else "developer-id",
        "identity": sign_identity,
        "teamId": expected_team_id or None,
        "adHocTestOnly": sign_identity == "-",
        "notaryStatus": notary_status,
        "notary": notary,
        "spctlStatus": spctl_status,
        "spctl": spctl,
    },
    "machOInventory": final_macho,
}
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
payload["receiptSha256"] = hashlib.sha256(canonical).hexdigest()
output_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PYTHON

if [[ -n "${staged_pack_root}" ]]; then
  /bin/rm -rf -- "${staged_pack_root}"
  staged_pack_root=""
fi
ark_refuse_unsafe_output "${destination}" >/dev/null
/bin/mv "${build_stage_root}" "${destination}"
build_stage_root=""

print -r -- "${final_app_path}"
