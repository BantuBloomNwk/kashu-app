import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// no source maps in the published site: the code people download is the minified build only
// the client builders live one folder up, shared with the tests
export default defineConfig({ plugins: [react()], base: './', build: { sourcemap: false }, server: { fs: { allow: ['..'] } } });
