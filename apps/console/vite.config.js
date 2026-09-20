import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
     plugins: [react()],
     server: {
          port: 5173,
          // Proxy to the gateway so the browser makes same-origin requests and
          // CORS never becomes a development concern.
          proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
     },
});
