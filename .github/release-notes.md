自包含单二进制，覆盖 macOS（Apple Silicon / Intel）与 Linux（x64 / arm64），内置 PTY 运行时，不依赖本机 `node_modules`。

## 安装

```sh
curl -fsSL https://github.com/qirong77/mica-code/releases/latest/download/install.sh | sh
```

安装到 `~/.local/lib/mica`，并在 `~/.local/bin/mica` 生成启动器。

离线安装：下载对应 `mica-code-<os>-<arch>.tar.gz`，解压后执行其中的 `mica`。

## 校验

```sh
shasum -a 256 -c sha256sums.txt
```

完整改动见 [commits/latest](https://github.com/qirong77/mica-code/commits/latest)。
