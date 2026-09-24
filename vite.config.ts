import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  const apiPort = process.env.PORT || environment.PORT || '3000';

  return {
    build: {
      outDir: 'dist/client',
      sourcemap: true,
    },
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
