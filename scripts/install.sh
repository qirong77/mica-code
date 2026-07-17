#!/bin/sh
set -eu

INSTALL_DIR="${MICA_INSTALL_DIR:-$HOME/.local/bin}"
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
need_cmd base64
need_cmd tar

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

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t mica)"
trap 'rm -rf "$TMP_DIR"' 0 HUP INT TERM

cat > "$TMP_DIR/payload.tar.gz.b64" <<'MICA_PAYLOAD'
__MICA_PAYLOAD__
MICA_PAYLOAD

if base64 --decode "$TMP_DIR/payload.tar.gz.b64" > "$TMP_DIR/payload.tar.gz" 2>/dev/null; then
  :
elif base64 -d "$TMP_DIR/payload.tar.gz.b64" > "$TMP_DIR/payload.tar.gz" 2>/dev/null; then
  :
elif base64 -D < "$TMP_DIR/payload.tar.gz.b64" > "$TMP_DIR/payload.tar.gz" 2>/dev/null; then
  :
else
  echo "Failed to decode embedded mica payload." >&2
  exit 1
fi

mkdir -p "$TMP_DIR/payload"
tar -xzf "$TMP_DIR/payload.tar.gz" -C "$TMP_DIR/payload"

if [ ! -f "$TMP_DIR/payload/$ASSET" ]; then
  echo "Embedded payload does not include $ASSET." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod 755 "$TMP_DIR/payload/$ASSET"
cp "$TMP_DIR/payload/$ASSET" "$INSTALL_DIR/$BIN_NAME"
chmod 755 "$INSTALL_DIR/$BIN_NAME"

echo "Installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to PATH if needed." ;;
esac
