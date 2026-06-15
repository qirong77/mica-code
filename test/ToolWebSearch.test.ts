import { ToolWebSearch } from '../src/tools/ToolWebSearch.js';
const tool = new ToolWebSearch();
const apiKey = process.env.SERPER_API_KEY || 'dummy';
tool._searchSerper('when is new year', 10, apiKey).then(result => console.log(result));