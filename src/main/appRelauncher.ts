import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArmedRestart } from './appRestart'

export interface RelaunchOptions {
  packaged: boolean
  appRoot: string
  resourcesPath: string
  userData: string
  executable: string
  pid: number
  createdAt: number | null
  portableExecutable?: string
}

export async function armAppRelauncher(options: RelaunchOptions): Promise<ArmedRestart> {
  if (process.platform !== 'win32') throw new Error('Relançamento protegido disponível somente no Windows.')
  if (!options.createdAt || !Number.isSafeInteger(options.pid) || options.pid < 1) throw new Error('Identidade do processo não verificável.')
  const script = options.packaged ? join(options.resourcesPath, 'restart-agent-code.ps1') : join(options.appRoot, 'scripts', 'restart-agent-code.ps1')
  const launch = options.packaged ? options.portableExecutable : join(options.appRoot, 'start.bat')
  if (!launch) throw new Error('Executável portátil original não identificado.')
  await access(script)
  await access(launch)
  const root = join(options.userData, 'restart')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'request-'))
  const manifest = join(directory, 'request.json')
  await writeFile(manifest, JSON.stringify({
    targetPid: options.pid, executable: options.executable, createdAt: options.createdAt,
    mode: options.packaged ? 'portable' : 'dev', launch, appRoot: options.appRoot,
    deadline: Date.now() + 60_000
  }), { flag: 'wx' })
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Manifest', manifest], {
    detached: true, stdio: 'ignore', windowsHide: true
  })
  let failed: Error | undefined
  child.on('error', (error) => { failed = error })
  child.unref()
  const cancel = async (): Promise<void> => { await writeFile(join(directory, 'cancel'), '') }
  const wait = async (name: string): Promise<void> => {
    const until = Date.now() + 10_000
    while (Date.now() < until) {
      if (failed) throw failed
      const failure = await readFile(join(directory, 'failure'), 'utf8').catch(() => '')
      if (failure) throw new Error(failure)
      if (await access(join(directory, name)).then(() => true, () => false)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Relançador não confirmou ${name}. Diagnóstico: ${directory}`)
  }
  try { await wait('armed') } catch (error) { await cancel(); throw error }
  return {
    cancel,
    commit: async () => { await writeFile(join(directory, 'commit'), '', { flag: 'wx' }); await wait('committed') }
  }
}
