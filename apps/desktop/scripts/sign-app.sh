#!/usr/bin/env bash
#
# 用固定的本机自签证书给 mica 桌面端 .app 签名。
#
# 为什么需要它：electron-builder 签名时会带 `--timestamp` 向 Apple 时间戳服务器
# 请求，在只能走代理的机器上每个二进制都要等超时，整包卡 5-8 分钟。本机自用不需要
# 时间戳（只有对外分发才需要），这里省掉它，整个流程几秒。
#
# 跨机器行为：没有证书的机器（同事、CI、Linux/Windows）什么都不会发生——脚本打印
# 一行说明就退出 0，已经打出来的包保持 electron-builder 给的 adhoc 签名，能正常跑。
# 想让缺失证书变成硬失败（发布流水线）时设 MICA_SIGN_REQUIRED=1。
#
# 用法：
#   bash scripts/sign-app.sh                     # 签 dist/mac-arm64/mica-code-app.app
#   bash scripts/sign-app.sh path/to/app.app
#   MICA_SIGN_IDENTITY=xxx bash scripts/sign-app.sh
#   MICA_SIGN_REQUIRED=1 bash scripts/sign-app.sh   # 没证书就失败
#
# 配套打包命令见 npm scripts 的 pack:app（强制跳过 electron-builder 自己的签名）。
# 证书与钥匙串放在 ~/.mica/codesign/ 与 login keychain 的通用密码项（服务名
# mica-codesign），都不进仓库。

set -euo pipefail

APP="${1:-dist/mac-arm64/mica-code-app.app}"
IDENTITY="${MICA_SIGN_IDENTITY:-mica-codesign}"
KEYCHAIN="${MICA_SIGN_KEYCHAIN:-$HOME/Library/Keychains/mica-codesign.keychain-db}"
ENTITLEMENTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build/entitlements.mac.plist"
REQUIRED="${MICA_SIGN_REQUIRED:-0}"

# 平台先判断：非 macOS 上 app 本来就打不出来，不该报「找不到 app」。
if [[ "$(uname)" != "Darwin" ]]; then
  echo "非 macOS，不需要签名，跳过。"
  exit 0
fi

if [[ ! -d "$APP" ]]; then
  echo "找不到 app：$APP" >&2
  echo "先打包：npm run pack:app（在 apps/desktop 下）" >&2
  exit 1
fi

APP="$(cd "$APP" && pwd)"

# ---- 解锁钥匙串 ----
# 密码存在 login keychain 的通用密码项里，不进仓库；取不到就假设已解锁。
if [[ -f "$KEYCHAIN" ]]; then
  PASS="$(security find-generic-password -s "mica-codesign" -w 2>/dev/null || true)"
  if [[ -n "$PASS" ]]; then
    security unlock-keychain -p "$PASS" "$KEYCHAIN" 2>/dev/null || true
  fi
fi

skip_or_fail() {
  if [[ "$REQUIRED" == "1" ]]; then
    echo "缺少签名身份 \"$IDENTITY\"，且 MICA_SIGN_REQUIRED=1。" >&2
    exit 1
  fi
  echo "缺少签名身份 \"$IDENTITY\"（这台机器没有配自签证书），跳过签名。"
  echo "包的 adhoc 签名保持原样，可以运行；要签名见 ~/.mica/codesign/。"
  exit 0
}

if ! security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$IDENTITY\""; then
  skip_or_fail
fi

START=$(date +%s)
step() { printf '  %-32s' "$1"; }

# 只签 Mach-O。node-pty 的 prebuilds 里混着 win32 的 .node（MZ 头 4d5a9000），
# codesign 对它们会失败且毫无意义，所以按 Mach-O 魔数过滤。
# od 的字节之间带空格（` cf fa ed fe`），先去掉空白再比对。
MACHO_MAGIC='^(cffaedfe|cefaedfe|cafebabe|bebafeca|feedface|feedfacf)$'
sign_macho() {
  local file="$1"
  if ! head -c 4 "$file" 2>/dev/null | od -An -tx1 | tr -d ' \n' | grep -qE "$MACHO_MAGIC"; then
    return 1
  fi
  codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" "$file" >/dev/null 2>&1
}

echo "签名 $APP"
echo "身份 $IDENTITY"

# ---- 由内到外 ----
# 顺序有硬约束：先签被引用者，再签引用者，否则外层签名会让内层改动失效。

step "Mach-O 文件 (.node/.dylib/.so)"
COUNT=0
while IFS= read -r -d '' f; do
  if sign_macho "$f"; then COUNT=$((COUNT + 1)); fi
done < <(find "$APP" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0 2>/dev/null)
echo "$COUNT 个"

# framework 与嵌套 app 按路径深度倒序：越深的越先签。当前结构是平的，但换 Electron
# 版本或加原生依赖后可能出现嵌套，按深度排不必改脚本。
step "framework / 嵌套 app"
COUNT=0
while IFS= read -r target; do
  [[ -z "$target" ]] && continue
  if codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --entitlements "$ENTITLEMENTS" "$target" >/dev/null 2>&1; then
    COUNT=$((COUNT + 1))
  fi
done < <(
  find "$APP/Contents/Frameworks" -mindepth 1 -maxdepth 3 \
    \( -name '*.framework' -o -name '*.app' \) 2>/dev/null \
    | awk -F/ '{print NF" "$0}' | sort -rn | cut -d' ' -f2-
)
echo "$COUNT 个"

step "主 app"
codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --entitlements "$ENTITLEMENTS" "$APP" >/dev/null 2>&1
echo "完成"

step "校验 (deep + strict)"
if codesign --verify --deep --strict "$APP" 2>/tmp/.mica-sign-verify.$$; then
  echo "OK"
  rm -f /tmp/.mica-sign-verify.$$
else
  echo "失败"
  sed 's/^/  /' /tmp/.mica-sign-verify.$$
  rm -f /tmp/.mica-sign-verify.$$
  exit 1
fi

echo
echo "指定要求："
codesign -d -r- "$APP" 2>&1 | tail -1 | sed 's/^/  /'
echo
echo "签好了，用时 $(( $(date +%s) - START ))s"
