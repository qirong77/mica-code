import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9316' },
  },
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'charts', test: /[\\/]node_modules[\\/](echarts|zrender)[\\/]/ },
            { name: 'ui', test: /[\\/]node_modules[\\/](antd|@ant-design|rc-|@rc-component)/ },
          ],
        },
      },
    },
  },
});
