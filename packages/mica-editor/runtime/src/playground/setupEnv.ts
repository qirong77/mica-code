// Excalidraw fetches its own font/runtime assets on demand.
(window as Window & {EXCALIDRAW_ASSET_PATH?: string}).EXCALIDRAW_ASSET_PATH =
  'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/';
