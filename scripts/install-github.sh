#!/bin/sh
set -eu

REPO="${MICA_GITHUB_REPO:-qirong77/mica-code}"
VERSION="${MICA_VERSION:-latest}"

if [ "$VERSION" = "latest" ]; then
  INSTALL_SCRIPT_URL="${MICA_INSTALL_SCRIPT_URL:-https://github.com/$REPO/releases/latest/download/install.sh}"
else
  INSTALL_SCRIPT_URL="${MICA_INSTALL_SCRIPT_URL:-https://github.com/$REPO/releases/download/$VERSION/install.sh}"
fi

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$INSTALL_SCRIPT_URL" | sh
else
  echo "Required command not found: curl" >&2
  exit 1
fi
