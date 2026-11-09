#!/usr/bin/env bash
# Installs a package on a clean system in a container and checks that DK Code runs there: every native module loads
# and a window starts with the Chromium sandbox on, without a display on the host.
#
# Usage: build/linux/verify-package.sh <image> <package.rpm|package.deb> <output directory> [VS Code package]
#
# With a VS Code package, it is installed first to check that both editors can be installed side by side.

set -euo pipefail

APP=/usr/share/dk-code

inside() {
  local package=$1 vscode=${2:-}

  echo "=== install"
  case "$package" in
    *.rpm)
      dnf install -y -q ${vscode:+"$vscode"} "$package" xorg-x11-server-Xvfb ImageMagick procps-ng util-linux
      ;;
    *.deb)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq ${vscode:+"$vscode"} "$package" xvfb imagemagick procps
      ;;
  esac

  echo "=== files"
  test -x /usr/bin/dk-code
  readlink -f /usr/bin/dk-code
  test "$(stat -c %a "$APP/chrome-sandbox")" = 4755
  if [ -n "$vscode" ]; then
    command -v code
  fi

  useradd -m tester
  cat > /tmp/run-as-tester.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
APP=$APP
OUT=$OUT_INSIDE
EOF
  cat >> /tmp/run-as-tester.sh <<'EOF'
echo "=== version"
dk-code --version

echo "=== native modules"
find "$APP/resources/app/node_modules.asar.unpacked" -name '*.node' \( -path '*/prebuilds/linux-x64/*' -o -path '*-linux-x64*' -o -path '*/build/Release/*' \) -not -path '*/obj.target/*' > /tmp/modules.txt
test "$(wc -l < /tmp/modules.txt)" -ge 10
ELECTRON_RUN_AS_NODE=1 "$APP/dk-code" -e '
const fs = require("fs");
for (const file of fs.readFileSync("/tmp/modules.txt", "utf8").trim().split("\n")) {
	const name = file.replace(/.*\/(node_modules|extensions)[^/]*\//, "");
	try {
		process.dlopen({ exports: {} }, file);
		console.log("ok " + name);
	} catch (error) {
		// Windows-only modules are empty on Linux: the linker loaded them, they just register nothing.
		if (!error.message.includes("did not self-register")) {
			throw error;
		}
		console.log("empty " + name);
	}
}'

echo "=== start"
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
export DISPLAY=:99
PROFILE=$HOME/profile
dk-code --disable-gpu --user-data-dir "$PROFILE" --extensions-dir "$HOME/extensions" > "$OUT/start.log" 2>&1
sleep 40
ps -eo args | grep -F "$APP/dk-code" | grep -c -- '--type=renderer'
if ps -eo args | grep -F "$APP/dk-code" | grep -q -- '--no-sandbox'; then
  echo "Sandbox is off" >&2
  exit 1
fi
test -s "$PROFILE/User/globalStorage/state.vscdb"
import -display :99 -window root "$OUT/window.png"
cat "$PROFILE"/logs/*/main.log > "$OUT/main.log"
status=0
grep -r -h -E 'Cannot find module|ERR_DLOPEN|GLIBC_' --include='*.log' "$PROFILE/logs" || status=$?
case $status in
  0) echo "Errors in the logs" >&2; exit 1 ;;
  1) ;;
  *) echo "Cannot read the logs" >&2; exit 1 ;;
esac
pkill -f "$APP/dk-code" || true
EOF
  chmod 755 /tmp/run-as-tester.sh
  chown tester "$OUT_INSIDE"
  su tester -c /tmp/run-as-tester.sh
  chown -R "$HOST_IDS" "$OUT_INSIDE"

  echo "=== remove"
  case "$package" in
    *.rpm) dnf remove -y -q dk-code ;;
    *.deb) apt-get purge -y -qq dk-code ;;
  esac
  test ! -e /usr/bin/dk-code
  test ! -e "$APP/dk-code"
  echo "=== all checks passed"
}

if [ "${1:-}" = --inside ]; then
  shift
  OUT_INSIDE=/out
  inside "$@"
  exit 0
fi

if [ $# -lt 3 ]; then
  echo "Usage: $0 <image> <package.rpm|package.deb> <output directory> [VS Code package]" >&2
  exit 2
fi

IMAGE=$1
PACKAGE=$(realpath "$2")
OUT=$3
mkdir -p "$OUT"
OUT=$(realpath "$OUT")
SCRIPT=$(realpath "$0")

ARGS=(-v "$PACKAGE:/pkg/$(basename "$PACKAGE"):ro")
INNER=("/pkg/$(basename "$PACKAGE")")
if [ $# -ge 4 ]; then
  VSCODE=$(realpath "$4")
  ARGS+=(-v "$VSCODE:/pkg/$(basename "$VSCODE"):ro")
  INNER+=("/pkg/$(basename "$VSCODE")")
fi

# The SUID sandbox needs these to work inside a container, on a normal system it needs nothing. The package
# scripts run as root in this wide container, so use it only for our own builds.
docker run --rm \
  --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined --shm-size=1g \
  -e HOST_IDS="$(id -u):$(id -g)" \
  -v "$SCRIPT:/verify-package.sh:ro" -v "$OUT:/out" "${ARGS[@]}" \
  "$IMAGE" bash /verify-package.sh --inside "${INNER[@]}"
