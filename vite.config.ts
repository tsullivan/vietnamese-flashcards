import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';
import { viteSingleFile } from 'vite-plugin-singlefile';

// https://vite.dev/config/
// `--mode offline` produces a single self-contained index.html (in dist-offline/)
// that runs from the file:// protocol with no network — for sideloading onto a
// device. The default build still targets GitHub Pages.
export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';

  return {
    base: offline ? './' : '/vietnamese-flashcards/',
    build: offline ? { outDir: 'dist-offline' } : {},
    plugins: [
      vue(),
      vueDevTools(),
      ...(offline ? [viteSingleFile()] : []),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  };
});
