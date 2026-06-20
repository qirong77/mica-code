#!/usr/bin/env bash
set -euo pipefail

REPO="${MICA_GITHUB_REPO:-}"
VERSION="${MICA_VERSION:-latest}"
INSTALL_DIR="${MICA_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="mica"

if [[ -z "$REPO" ]]; then
  if command -v git >/dev/null 2>&1; then
    ORIGIN_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
    if [[ "$ORIGIN_URL" =~ github.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
      REPO="${BASH_REMATCH[1]}"
    fi
  fi
fi

if [[ -z "$REPO" ]]; then
  echo "MICA_GITHUB_REPO is required, for example:"
  echo "  curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-github.sh | MICA_GITHUB_REPO=<owner>/<repo> bash"
  exit 1
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  darwin) PLATFORM="darwin" ;;
  linux) PLATFORM="linux" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) CPU="x64" ;;
  arm64|aarch64) CPU="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ASSET="mica-${PLATFORM}-${CPU}.tar.gz"
BASE_URL="https://github.com/${REPO}/releases"
if [[ "$VERSION" == "latest" ]]; then
  URL="${BASE_URL}/latest/download/${ASSET}"
else
  URL="${BASE_URL}/download/${VERSION}/${ASSET}"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$INSTALL_DIR"
echo "Downloading ${URL}"
curl -fL "$URL" -o "$TMP_DIR/$ASSET"
tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
install -m 755 "$TMP_DIR/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"

echo "Installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to PATH if needed." ;;
esac
