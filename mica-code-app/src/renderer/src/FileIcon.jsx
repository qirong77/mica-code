import defaultFile from '../assets/file-icons/default_file.svg'
import c from '../assets/file-icons/file_type_c.svg'
import cpp from '../assets/file-icons/file_type_cpp.svg'
import csharp from '../assets/file-icons/file_type_csharp.svg'
import css from '../assets/file-icons/file_type_css.svg'
import eslint from '../assets/file-icons/file_type_eslint.svg'
import git from '../assets/file-icons/file_type_git.svg'
import html from '../assets/file-icons/file_type_html.svg'
import js from '../assets/file-icons/file_type_js.svg'
import json from '../assets/file-icons/file_type_json.svg'
import markdown from '../assets/file-icons/file_type_markdown.svg'
import npm from '../assets/file-icons/file_type_npm.svg'
import pnpm from '../assets/file-icons/file_type_pnpm.svg'
import python from '../assets/file-icons/file_type_python.svg'
import shell from '../assets/file-icons/file_type_shell.svg'
import sql from '../assets/file-icons/file_type_sql.svg'
import toml from '../assets/file-icons/file_type_toml.svg'
import typescript from '../assets/file-icons/file_type_typescript.svg'
import vue from '../assets/file-icons/file_type_vue.svg'
import xml from '../assets/file-icons/file_type_xml.svg'
import yaml from '../assets/file-icons/file_type_yaml.svg'
import defaultFolder from '../assets/file-icons/default_folder.svg'
import defaultFolderOpened from '../assets/file-icons/default_folder_opened.svg'
import configFolder from '../assets/file-icons/folder_type_config.svg'
import configFolderOpened from '../assets/file-icons/folder_type_config_opened.svg'
import gitFolder from '../assets/file-icons/folder_type_git.svg'
import gitFolderOpened from '../assets/file-icons/folder_type_git_opened.svg'
import nodeFolder from '../assets/file-icons/folder_type_node.svg'
import nodeFolderOpened from '../assets/file-icons/folder_type_node_opened.svg'
import publicFolder from '../assets/file-icons/folder_type_public.svg'
import publicFolderOpened from '../assets/file-icons/folder_type_public_opened.svg'
import srcFolder from '../assets/file-icons/folder_type_src.svg'
import srcFolderOpened from '../assets/file-icons/folder_type_src_opened.svg'
import testFolder from '../assets/file-icons/folder_type_test.svg'
import testFolderOpened from '../assets/file-icons/folder_type_test_opened.svg'

const folderIconPairs = {
  config: [configFolder, configFolderOpened],
  default: [defaultFolder, defaultFolderOpened],
  git: [gitFolder, gitFolderOpened],
  node: [nodeFolder, nodeFolderOpened],
  public: [publicFolder, publicFolderOpened],
  src: [srcFolder, srcFolderOpened],
  test: [testFolder, testFolderOpened]
}

const folderKinds = new Map([
  ['src', 'src'],
  ['source', 'src'],
  ['sources', 'src'],
  ['app', 'src'],
  ['apps', 'src'],
  ['public', 'public'],
  ['static', 'public'],
  ['www', 'public'],
  ['node_modules', 'node'],
  ['.git', 'git'],
  ['.github', 'git'],
  ['.gitlab', 'git'],
  ['test', 'test'],
  ['tests', 'test'],
  ['__tests__', 'test'],
  ['spec', 'test'],
  ['specs', 'test'],
  ['e2e', 'test'],
  ['cypress', 'test'],
  ['config', 'config'],
  ['configs', 'config'],
  ['settings', 'config'],
  ['.config', 'config'],
  ['.vscode', 'config'],
  ['.idea', 'config']
])

const filenameIcons = new Map([
  ['.editorconfig', defaultFile],
  ['.eslintignore', eslint],
  ['.eslintrc', eslint],
  ['.eslintrc.json', eslint],
  ['.eslintrc.yml', eslint],
  ['.eslintrc.yaml', eslint],
  ['.eslintrc.js', eslint],
  ['.eslintrc.cjs', eslint],
  ['eslint.config.js', eslint],
  ['eslint.config.mjs', eslint],
  ['eslint.config.cjs', eslint],
  ['eslint.config.ts', eslint],
  ['.prettierignore', defaultFile],
  ['.prettierrc', defaultFile],
  ['.prettierrc.json', defaultFile],
  ['prettier.config.js', js],
  ['prettier.config.cjs', js],
  ['.gitignore', git],
  ['.gitattributes', git],
  ['.gitmodules', git],
  ['package.json', npm],
  ['package-lock.json', npm],
  ['npm-shrinkwrap.json', npm],
  ['.npmrc', npm],
  ['yarn.lock', defaultFile],
  ['.yarnrc', defaultFile],
  ['pnpm-lock.yaml', pnpm],
  ['pnpm-workspace.yaml', pnpm],
  ['dockerfile', defaultFile],
  ['docker-compose.yml', yaml],
  ['docker-compose.yaml', yaml],
  ['compose.yml', yaml],
  ['compose.yaml', yaml],
  ['cmakelists.txt', defaultFile],
  ['tsconfig.json', typescript],
  ['jsconfig.json', js],
  ['vite.config.js', js],
  ['vite.config.mjs', js],
  ['vite.config.ts', typescript],
  ['vite.config.mts', typescript],
  ['webpack.config.js', js],
  ['webpack.config.cjs', js],
  ['webpack.config.ts', typescript],
  ['readme', markdown],
  ['readme.md', markdown],
  ['readme.mdx', markdown],
  ['license', markdown],
  ['license.md', markdown],
  ['cargo.toml', toml],
  ['cargo.lock', defaultFile],
  ['go.mod', defaultFile],
  ['go.sum', defaultFile]
])

const compoundExtensionIcons = new Map([
  ['d.ts', typescript],
  ['d.mts', typescript],
  ['d.cts', typescript],
  ['test.js', js],
  ['spec.js', js],
  ['test.jsx', js],
  ['spec.jsx', js],
  ['test.ts', typescript],
  ['spec.ts', typescript],
  ['test.tsx', typescript],
  ['spec.tsx', typescript],
  ['stories.jsx', js],
  ['stories.tsx', typescript]
])

const extensionIcons = new Map([
  ['html', html],
  ['htm', html],
  ['css', css],
  ['scss', css],
  ['sass', css],
  ['js', js],
  ['mjs', js],
  ['cjs', js],
  ['jsx', js],
  ['ts', typescript],
  ['mts', typescript],
  ['cts', typescript],
  ['tsx', typescript],
  ['vue', vue],
  ['svelte', defaultFile],
  ['astro', defaultFile],
  ['json', json],
  ['jsonc', json],
  ['yaml', yaml],
  ['yml', yaml],
  ['toml', toml],
  ['xml', xml],
  ['svg', xml],
  ['md', markdown],
  ['mdx', markdown],
  ['py', python],
  ['pyw', python],
  ['go', defaultFile],
  ['rs', defaultFile],
  ['c', c],
  ['h', c],
  ['cc', cpp],
  ['cpp', cpp],
  ['cxx', cpp],
  ['hpp', cpp],
  ['cs', csharp],
  ['java', defaultFile],
  ['php', defaultFile],
  ['rb', defaultFile],
  ['sh', shell],
  ['bash', shell],
  ['zsh', shell],
  ['fish', shell],
  ['ps1', shell],
  ['psm1', shell],
  ['sql', sql]
])

function basename(path) {
  return String(path || '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .toLowerCase()
}

export function resolveFileIcon(path) {
  const name = basename(path)
  const filenameMatch = filenameIcons.get(name)
  if (filenameMatch) return filenameMatch

  const parts = name.split('.')
  for (let index = 1; index < parts.length - 1; index += 1) {
    const compoundMatch = compoundExtensionIcons.get(parts.slice(index).join('.'))
    if (compoundMatch) return compoundMatch
  }

  return extensionIcons.get(parts.at(-1)) || defaultFile
}

export function resolveFolderIcon(path, expanded = false) {
  const kind = folderKinds.get(basename(path)) || 'default'
  return folderIconPairs[kind][expanded ? 1 : 0]
}

export function FileIcon({ name, className = '', ...props }) {
  return (
    <img
      src={resolveFileIcon(name)}
      alt=""
      aria-hidden="true"
      draggable="false"
      className={`shrink-0 object-contain ${className}`}
      {...props}
    />
  )
}

export function FolderIcon({ name, expanded = false, className = '', ...props }) {
  return (
    <img
      src={resolveFolderIcon(name, expanded)}
      alt=""
      aria-hidden="true"
      draggable="false"
      className={`shrink-0 object-contain ${className}`}
      {...props}
    />
  )
}
