import { app } from 'electron'
import { devDataDir } from './devDataDir'
import { applyGpuMode, createGpuCrashHandler, type GpuModeState } from './gpuSafeMode'

/**
 * Importado logo depois de devDataDirBoot (o `userData` já é o certo): liga o
 * modo seguro da GPU antes do `ready` e passa a vigiar as quedas da GPU desde
 * o primeiro instante — é na abertura que o app morria (gpuSafeMode.ts).
 */
const dir = app.getPath('userData')
export const gpuModeAtBoot: GpuModeState = applyGpuMode(app, dir)

const noRelaunch = Boolean(devDataDir()) && process.env['AGENT_CODE_DEV_NO_RELAUNCH'] === '1'
const onGpuGone = createGpuCrashHandler({
  dir,
  state: gpuModeAtBoot,
  startedAt: Date.now(),
  relaunch: noRelaunch
    ? undefined
    : () => {
        app.relaunch()
        app.quit()
      }
})
app.on('child-process-gone', (_event, details) => onGpuGone(details))
