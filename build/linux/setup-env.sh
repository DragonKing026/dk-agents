#!/usr/bin/env bash
# Toolchain for the native modules of a release build. Source it before `npm rebuild` or `npm ci`.
#
# Without it node-gyp uses the host compiler, so the modules require the glibc and libstdc++ of the build
# machine and the packages do not run on older systems. This builds them like Electron itself: Chromium clang,
# libc++ from the Electron release and a glibc 2.28 sysroot.
#
# Based on build/azure-pipelines/linux/setup-env.sh from microsoft/vscode 1.145.2 (MIT): x64 only, without the
# remote server toolchain and without writing to ~/.gyp.

set -e

VSCODE_CLIENT_SYSROOT_DIR=$PWD/.build/sysroots/glibc-2.28-gcc-10.5.0
if [ -d "$VSCODE_CLIENT_SYSROOT_DIR" ]; then
  echo "Using cached client sysroot"
else
  echo "Downloading client sysroot"
  VSCODE_SYSROOT_DIR="$VSCODE_CLIENT_SYSROOT_DIR" node -e 'import { getVSCodeSysroot } from "./build/linux/debian/install-sysroot.ts"; (async () => { await getVSCodeSysroot("amd64"); })()'
fi

if [ ! -x "$PWD/.build/CR_Clang/bin/clang" ]; then
  echo "Downloading Chromium clang"
  mkdir -p .build
  CLANG_UPDATE_PY="$PWD/.build/clang-update.py" node -e 'import { downloadChromiumFile } from "./build/lib/chromiumSource.ts"; downloadChromiumFile("tools/clang/scripts/update.py", process.env["CLANG_UPDATE_PY"]);'
  python3 "$PWD/.build/clang-update.py" --output-dir="$PWD/.build/CR_Clang" --host-os=linux
fi

DEBUG=libcxx-fetcher \
VSCODE_LIBCXX_OBJECTS_DIR=$PWD/.build/libcxx-objects \
VSCODE_LIBCXX_HEADERS_DIR=$PWD/.build/libcxx_headers \
VSCODE_LIBCXXABI_HEADERS_DIR=$PWD/.build/libcxxabi_headers \
VSCODE_ARCH=x64 \
node build/linux/libcxx-fetcher.ts

SYSROOT=$VSCODE_CLIENT_SYSROOT_DIR/x86_64-linux-gnu/x86_64-linux-gnu/sysroot
export CC="$PWD/.build/CR_Clang/bin/clang --gcc-toolchain=$VSCODE_CLIENT_SYSROOT_DIR/x86_64-linux-gnu"
export CXX="$PWD/.build/CR_Clang/bin/clang++ --gcc-toolchain=$VSCODE_CLIENT_SYSROOT_DIR/x86_64-linux-gnu"
export CXXFLAGS="-nostdinc++ -D__NO_INLINE__ -DSPDLOG_USE_STD_FORMAT -I$PWD/.build/libcxx_headers -isystem$PWD/.build/libcxx_headers/include -isystem$PWD/.build/libcxxabi_headers/include -fPIC -flto=thin -fsplit-lto-unit -D_LIBCPP_ABI_NAMESPACE=Cr -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE --sysroot=$SYSROOT"
export LDFLAGS="-stdlib=libc++ --sysroot=$SYSROOT -fuse-ld=lld -flto=thin -L$PWD/.build/libcxx-objects -lc++abi -L$SYSROOT/usr/lib/x86_64-linux-gnu -L$SYSROOT/lib/x86_64-linux-gnu -Wl,--lto-O0"
