import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Keep the Agent SDK and Playwright as runtime requires from node_modules
    // (they spawn subprocesses / native browsers and must not be bundled).
    // The local voice engine (src/main/voice) loads native/WASM packages that
    // resolve files relative to their own folder (onnxruntime-node's .node and
    // DLLs, kokoro-js's voices/*.bin, eSpeak's espeak-ng.data): they must stay
    // runtime imports from node_modules. They are `dependencies`, so the plugin
    // already externalizes them; `include` pins the transitive ones too.
    // `electron-updater` vai no bundle do main (com as dependências dele): o
    // `files` do electron-builder.yml é explícito e não o levaria de node_modules
    // para o instalador; scripts/check-deps.mjs confere a marca dele em out/main.
    plugins: [
      externalizeDepsPlugin({ include: ['onnxruntime-node', 'onnxruntime-common', 'sharp'], exclude: ['electron-updater'] })
    ],
    // The installed app has no smartfone-remote of its own: the APK build goes
    // back to the repo it was built from (see REMOTE_ROOT in src/main/index.ts).
    define: { __AGENT_CODE_REPO__: JSON.stringify(resolve('.')) },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Separate entries: voiceWorker.js is forked as a utilityProcess, and
          // voice.js resolves it as its sibling (host.ts resolveWorkerPath).
          voice: resolve('src/main/voice/index.ts'),
          voiceWorker: resolve('src/main/voice/worker.ts'),
          // worker_threads da fila de gravação (persistence/writeQueue/preparer.ts)
          // e do export diário em parquet (parquetExport.ts): irmãos do index.js.
          conversationPrepareWorker: resolve('src/main/persistence/writeQueue/prepareWorker.ts'),
          parquetExportWorker: resolve('src/main/parquetExportWorker.ts'),
          // worker_threads da sincronização de skills (skills/skillSync.ts): irmão
          // do index.js; nada no caminho dele importa 'electron'.
          skillSyncWorker: resolve('src/main/skills/skillSyncWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
