#!/usr/bin/env bash
# Builds the RPM and DEB packages from a finished `gulp vscode-linux-x64-min` build. Each format is built in a
# container with its own tools, so the result does not depend on the host and the path may contain spaces.
#
# The native modules of that build must come from build/linux/setup-env.sh, otherwise the dependency check fails.
#
# Usage: build/linux/package-in-docker.sh <VSCode-linux-x64 directory> <Node.js directory> [rpm] [deb]

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <VSCode-linux-x64 directory> <Node.js directory> [rpm] [deb]" >&2
  exit 2
fi

APP_DIR=$(realpath "$1")
NODE_DIR=$(realpath "$2")
shift 2
FORMATS=("$@")
if [ ${#FORMATS[@]} -eq 0 ]; then
  FORMATS=(rpm deb)
fi

REPO_DIR=$(realpath "$(dirname "$0")/../..")
SYSROOT=.build/sysroots/glibc-2.28-gcc-10.5.0
run_gulp() {
  local image=$1 format=$2
  # HOME and the temporary files of one format, kept between runs for the downloaded Debian sysroot.
  local cache_dir="$REPO_DIR/.build/package-cache/$format"
  mkdir -p "$cache_dir"
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$REPO_DIR:/src" \
    -v "$APP_DIR:/VSCode-linux-x64:ro" \
    -v "$NODE_DIR:/node:ro" \
    -v "$cache_dir:/tmp" \
    -w /src \
    -e HOME=/tmp \
    -e VSCODE_SYSROOT_DIR="/src/$SYSROOT" \
    -e PATH=/node/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$image" \
    bash -c "npm run gulp vscode-linux-x64-prepare-$format && npm run gulp vscode-linux-x64-build-$format"
}

for format in "${FORMATS[@]}"; do
  case "$format" in
    rpm)
      docker build -q -t dk-code-rpm-builder - <<'EOF'
FROM fedora:44
RUN dnf install -y -q rpm-build findutils
EOF
      run_gulp dk-code-rpm-builder rpm
      ls -l "$REPO_DIR"/.build/linux/rpm/x86_64/*.rpm
      ;;
    deb)
      docker build -q -t dk-code-deb-builder - <<'EOF'
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends dpkg-dev fakeroot ca-certificates python3 xz-utils curl
EOF
      run_gulp dk-code-deb-builder deb
      ls -l "$REPO_DIR"/.build/linux/deb/amd64/deb/*.deb
      ;;
    *)
      echo "Unknown format: $format" >&2
      exit 2
      ;;
  esac
done
