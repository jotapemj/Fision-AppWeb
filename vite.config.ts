import { defineConfig } from 'vite';

// Server real para el proxy de desarrollo (mismo origen que en produccion)
const SERVER = process.env.FISION_SERVER ?? 'http://localhost:8000';
const API = ['/login', '/auth', '/health', '/jobs', '/library', '/playlists', '/server'];

// SharedArrayBuffer (hilos WASM) exige aislamiento de origen
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: '/app/', // el server sirve la web en /app
  server: {
    port: 5173,
    strictPort: true,
    headers: isolation,
    proxy: Object.fromEntries(API.map((p) => [p, { target: SERVER, changeOrigin: true }])),
  },
  preview: { port: 4173, headers: isolation },
  build: { target: 'es2022' },
});
