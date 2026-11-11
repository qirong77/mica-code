import '@arco-design/web-react/dist/css/arco.css';
import '@arco-design/web-react/es/_util/react-19-adapter';
import '../playground/index.css';
import '../workspace/workspace.css';
import '../workspace/notebook.css';
import './markdown.css';
import {ConfigProvider} from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import MarkdownApp from './MarkdownApp';
import {MarkdownFrame} from './MarkdownBridge';

createRoot(document.getElementById('root')!).render(<StrictMode><ConfigProvider locale={zhCN} size="small" autoInsertSpaceInButton={false}><MarkdownFrame><MarkdownApp /></MarkdownFrame></ConfigProvider></StrictMode>);
