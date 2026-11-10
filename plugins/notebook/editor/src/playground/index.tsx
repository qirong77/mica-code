/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import '@arco-design/web-react/dist/css/arco.css';
import '@arco-design/web-react/es/_util/react-19-adapter';
import './index.css';
import '../workspace/workspace.css';
import '../workspace/notebook.css';

import * as React from 'react';
import {ConfigProvider} from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {createRoot} from 'react-dom/client';

import App from './App';
import setupEnv from './setupEnv';

if (setupEnv.emptyEditor) {
  // vite is really aggressive about tree-shaking, this
  // ensures that the side-effects of importing setupEnv happens
}

// Handle runtime errors
const showErrorOverlay = (err: Event) => {
  const ErrorOverlay = customElements.get('vite-error-overlay');
  if (!ErrorOverlay) {
    return;
  }
  const overlay = new ErrorOverlay(err);
  const body = document.body;
  if (body !== null) {
    body.appendChild(overlay);
  }
};

window.addEventListener('error', showErrorOverlay);
window.addEventListener('unhandledrejection', ({reason}) =>
  showErrorOverlay(reason),
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} size="small" autoInsertSpaceInButton={false}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
