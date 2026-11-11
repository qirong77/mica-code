import {INITIAL_SETTINGS} from './appSettings';

// Excalidraw fetches its own font/runtime assets on demand.
(window as Window & {EXCALIDRAW_ASSET_PATH?: string}).EXCALIDRAW_ASSET_PATH =
  'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/';

// Notebook settings are local UI state, not URL-controlled editor graphs.
// In particular do not interpret the host nonce as a shared-document hash.
export default INITIAL_SETTINGS;
