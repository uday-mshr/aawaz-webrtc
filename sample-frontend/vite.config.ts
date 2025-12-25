import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Plugin to handle ONNX Runtime files correctly
const onnxRuntimePlugin = () => ({
  name: 'onnxruntime-handler',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Handle ONNX Runtime files - serve as-is without processing
      if (req.url?.startsWith('/onnxruntime-web/')) {
        // Remove ?import query parameter if present
        const cleanUrl = req.url.split('?')[0];
        req.url = cleanUrl;
        // Set proper MIME type
        if (cleanUrl.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'application/javascript');
        } else if (cleanUrl.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), onnxRuntimePlugin()],
  server: {
    port: 5173,
    fs: {
      // Allow serving files from public directory
      strict: false,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  publicDir: 'public',
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
})

