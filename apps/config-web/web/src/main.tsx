import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConfigWebApp,
  setConfigWebClient,
  setConfigWebEditor,
} from '@packages/mica-config-ui/web/index.js';
import { createHttpConfigWebClient } from './http-client.js';
import { MonacoJsonEditor } from './monaco-editor.js';

// 宿主侧接线：页面组件来自共享包，数据源与编辑器由这个壳提供。
setConfigWebClient(createHttpConfigWebClient());
setConfigWebEditor(MonacoJsonEditor);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigWebApp />
  </React.StrictMode>,
);
