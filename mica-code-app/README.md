# mica-code-app

Mica Code is a compact Electron terminal workspace with session management, file editing, workspace search, and Git diff views.

## Tech stack

- Electron + electron-vite
- React 19 + React DOM
- Vite + `@vitejs/plugin-react`
- Tailwind CSS v4 + `@tailwindcss/vite`
- xterm.js for terminal rendering
- Monaco Editor for file editing and Git comparisons
- lucide-react for product icons

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Renderer production build

```bash
$ npm run build
```

### Package

```bash
# Windows
$ npm run build:win

# macOS
$ npm run build:mac

# Linux
$ npm run build:linux
```
