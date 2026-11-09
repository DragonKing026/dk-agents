#!/usr/bin/env bash
# Toolchain for the native modules of a release build. Source it from the repository root before `npm rebuild`
# or `npm ci`: `source build/linux/setup-env.sh`.
#
# Without it node-gyp uses the host compiler, so the modules require the glibc and libstdc++ of the build
# machine and the packages do not run on older systems. This builds them like Electron itself: Chromium clang,
# libc++ from the Electron release and a glibc 2.28 sysroot.
#
# Based on build/azure-pipelines/linux/setup-env.sh from microsoft/vscode 1.145.2 (MIT): x64 only, without the
# remote server toolchain and without writing to ~/.gyp.

(return 0 2>/dev/null) || { echo "Source this file: source $0" >&2; exit 1; }

dk_setup_env() {
  case $PWD in
    *" "*)
      echo "The path contains a space, node-gyp splits CC and CXXFLAGS on it. Build from a path without spaces." >&2
      return 1
      ;;
  esac

  local client_sysroot=$PWD/.build/sysroots/glibc-2.28-gcc-10.5.0
  # Skips the download when the stamp it writes after a complete download is there.
  VSCODE_SYSROOT_DIR="$client_sysroot" node -e 'import { getVSCodeSysroot } from "./build/linux/debian/install-sysroot.ts"; (async () => { await getVSCodeSysroot("amd64"); })()' || return 1

  if [ ! -x "$PWD/.build/CR_Clang/bin/clang" ]; then
    echo "Downloading Chromium clang"
    local partial=$PWD/.build/CR_Clang.partial
    rm -rf "$partial"
    mkdir -p "$partial"
    CLANG_UPDATE_PY="$partial/update.py" node -e 'import { downloadChromiumFile } from "./build/lib/chromiumSource.ts"; downloadChromiumFile("tools/clang/scripts/update.py", process.env["CLANG_UPDATE_PY"]);' || return 1
    python3 "$partial/update.py" --output-dir="$partial/clang" --host-os=linux || return 1
    mv "$partial/clang" "$PWD/.build/CR_Clang"
    rm -rf "$partial"
  fi

  DEBUG=libcxx-fetcher \
  VSCODE_LIBCXX_OBJECTS_DIR=$PWD/.build/libcxx-objects \
  VSCODE_LIBCXX_HEADERS_DIR=$PWD/.build/libcxx_headers \
  VSCODE_LIBCXXABI_HEADERS_DIR=$PWD/.build/libcxxabi_headers \
  VSCODE_ARCH=x64 \
  node build/linux/libcxx-fetcher.ts || return 1

  local sysroot=$client_sysroot/x86_64-linux-gnu/x86_64-linux-gnu/sysroot
  export CC="$PWD/.build/CR_Clang/bin/clang --gcc-toolchain=$client_sysroot/x86_64-linux-gnu"
  export CXX="$PWD/.build/CR_Clang/bin/clang++ --gcc-toolchain=$client_sysroot/x86_64-linux-gnu"
  export CXXFLAGS="-nostdinc++ -D__NO_INLINE__ -DSPDLOG_USE_STD_FORMAT -I$PWD/.build/libcxx_headers -isystem$PWD/.build/libcxx_headers/include -isystem$PWD/.build/libcxxabi_headers/include -fPIC -flto=thin -fsplit-lto-unit -D_LIBCPP_ABI_NAMESPACE=Cr -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE --sysroot=$sysroot"
  export LDFLAGS="-stdlib=libc++ --sysroot=$sysroot -fuse-ld=lld -flto=thin -L$PWD/.build/libcxx-objects -lc++abi -L$sysroot/usr/lib/x86_64-linux-gnu -L$sysroot/lib/x86_64-linux-gnu -Wl,--lto-O0"
}

dk_setup_env
dk_setup_env_status=$?
unset -f dk_setup_env
return $dk_setup_env_status
