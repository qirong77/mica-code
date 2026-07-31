// Ambient declaration for Bun/Vite `?raw` imports used to embed the Node-side
// PTY server source (packages/mica-pty/src/server.mjs) as a plain string.
declare module '*.mjs?raw' {
  const content: string;
  export default content;
}
