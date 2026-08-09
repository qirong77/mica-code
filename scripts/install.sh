#!/bin/sh
# Mica Code release installer.
# Product: mica-code. CLI command: mica.
# Downloads only the current platform archive from GitHub Releases.
#
# 新版发布包内含 node-pty 运行时（mica + node_modules/node-pty），解压到
# ~/.local/lib/mica/，~/.local/bin/mica 只是 launcher。PTY 工具开箱即用，
# 不依赖用户机器上的 node_modules。
set -eu

REPO="${MICA_GITHUB_REPO:-qirong77/mica-code}"
VERSION="${MICA_VERSION:-${1:-latest}}"
INSTALL_DIR="${MICA_INSTALL_DIR:-$HOME/.local/bin}"
PACKAGE_DIR="${MICA_PACKAGE_DIR:-$HOME/.local/lib/mica}"
BIN_NAME="${MICA_BIN_NAME:-mica}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

need_cmd uname
need_cmd tr
need_cmd mktemp
need_cmd mkdir
need_cmd chmod
need_cmd cp
need_cmd tar
need_cmd rm

if command -v curl >/dev/null 2>&1; then
  DOWNLOAD_CMD="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD_CMD="wget"
else
  echo "Required command not found: curl or wget" >&2
  exit 1
fi

download() {
  url="$1"
  out="$2"
  if [ "$DOWNLOAD_CMD" = "curl" ]; then
    curl -fsSL "$url" -o "$out"
  else
    wget -qO "$out" "$url"
  fi
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "Required command not found: sha256sum or shasum" >&2
    exit 1
  fi
}

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) PLATFORM="darwin" ;;
  linux) PLATFORM="linux" ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64 | amd64) CPU="x64" ;;
  arm64 | aarch64) CPU="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ASSET="mica-code-${PLATFORM}-${CPU}"
ARCHIVE="${ASSET}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t mica)"
trap 'rm -rf "$TMP_DIR"' 0 HUP INT TERM

echo "Downloading ${ARCHIVE} from ${BASE_URL} ..."
download "${BASE_URL}/${ARCHIVE}" "${TMP_DIR}/${ARCHIVE}"
download "${BASE_URL}/sha256sums.txt" "${TMP_DIR}/sha256sums.txt"

EXPECTED_SHA="$(
  awk -v archive="$ARCHIVE" '
    $2 == archive || $2 == ("./" archive) || $2 == ("*" archive) {
      print $1
      found = 1
      exit
    }
    END {
      if (!found) exit 1
    }
  ' "${TMP_DIR}/sha256sums.txt"
)" || {
  echo "Could not find ${ARCHIVE} in sha256sums.txt" >&2
  exit 1
}

ACTUAL_SHA="$(sha256_file "${TMP_DIR}/${ARCHIVE}")"
if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "Checksum mismatch for ${ARCHIVE}" >&2
  echo "  expected: ${EXPECTED_SHA}" >&2
  echo "  actual:   ${ACTUAL_SHA}" >&2
  exit 1
fi

# 完整解压（mica 二进制 + node_modules/node-pty）到 package dir，先清空旧版本残留。
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"
tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "$PACKAGE_DIR"

if [ ! -f "${PACKAGE_DIR}/mica" ]; then
  echo "Archive does not include mica binary." >&2
  exit 1
fi
chmod 755 "${PACKAGE_DIR}/mica"

# node-pty 的 spawn-helper 需要可执行位（tar 可能丢失或本来就缺）。
find "$PACKAGE_DIR/node_modules" -name spawn-helper -exec chmod 755 {} + 2>/dev/null || true

# launcher 指向 package dir 内的二进制；旧版本这里直接是二进制，会被覆盖。
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/${BIN_NAME}" <<EOF
#!/bin/sh
exec "${PACKAGE_DIR}/mica" "\$@"
EOF
chmod 755 "${INSTALL_DIR}/${BIN_NAME}"

echo "Installed ${BIN_NAME} to ${INSTALL_DIR}/${BIN_NAME}"
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to PATH if needed." ;;
esac
