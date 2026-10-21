import eslintConfig from '@electron-toolkit/eslint-config'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  eslintConfig,
  {
    files: ['src/renderer/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 渲染期读到还没初始化的 const 会直接抛 TDZ 错误，而 React 随后卸掉整棵树 ——
      // 用户看到的就是整页黑屏（2026-10 撞过一次）。函数体内的延后引用另算，按处豁免。
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true }]
    }
  },
  eslintConfigPrettier
]
