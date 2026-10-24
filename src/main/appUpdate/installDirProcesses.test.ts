import { describe, expect, it } from 'vitest'
import {
  LIST_PROCESSES_COMMAND,
  filterInstallDirProcesses,
  isInsideDir,
  killProcessTree,
  listInstallDirProcesses,
  parseProcessRows
} from './installDirProcesses'

const ROOT = 'C:\\Users\\x\\AppData\\Local\\Programs\\Agent Code'

describe('installDirProcesses', () => {
  it('isInsideDir ignora maiúsculas e barras e exige a pasta inteira', () => {
    expect(isInsideDir('c:/users/x/appdata/local/programs/agent code/resources/postgres/bin/postgres.exe', ROOT)).toBe(true)
    expect(isInsideDir('C:\\Users\\x\\AppData\\Local\\Programs\\Agent Code 2\\a.exe', ROOT)).toBe(false)
    expect(isInsideDir('C:\\Windows\\System32\\svchost.exe', ROOT)).toBe(false)
  })

  it('filtra só os processos da pasta, sem o próprio app, sem os auxiliares do mesmo exe, sem os de sistema', () => {
    const rows = [
      { ProcessId: 100, ExecutablePath: `${ROOT}\\Agent Code.exe` },
      // Renderer/GPU/utility do Electron e um MCP em ELECTRON_RUN_AS_NODE: o mesmo exe, saem com o app.
      { ProcessId: 105, ExecutablePath: `${ROOT.toLowerCase()}\\agent code.exe` },
      { ProcessId: 101, ExecutablePath: `${ROOT}\\resources\\postgres\\bin\\postgres.exe` },
      { ProcessId: 102, ExecutablePath: `${ROOT.toUpperCase()}\\RESOURCES\\MS-PLAYWRIGHT\\CHROME.EXE` },
      { ProcessId: 103, ExecutablePath: null },
      { ProcessId: 104, ExecutablePath: 'C:\\Windows\\explorer.exe' },
      { ProcessId: 'x', ExecutablePath: `${ROOT}\\a.exe` },
      null
    ]
    expect(filterInstallDirProcesses(rows, ROOT, 100, `${ROOT}\\Agent Code.exe`)).toEqual([
      { pid: 101, path: `${ROOT}\\resources\\postgres\\bin\\postgres.exe` },
      { pid: 102, path: `${ROOT.toUpperCase()}\\RESOURCES\\MS-PLAYWRIGHT\\CHROME.EXE` }
    ])
    // Sem o exe informado, os auxiliares contam.
    expect(filterInstallDirProcesses(rows, ROOT, 100).map((p) => p.pid)).toEqual([105, 101, 102])
  })

  it('um objeto só (ConvertTo-Json sem lista) e saída vazia/BOM', () => {
    expect(filterInstallDirProcesses({ ProcessId: 7, ExecutablePath: `${ROOT}\\x.exe` }, ROOT, 1)).toEqual([
      { pid: 7, path: `${ROOT}\\x.exe` }
    ])
    expect(parseProcessRows('')).toEqual([])
    expect(parseProcessRows('\uFEFF[{"ProcessId":1,"ExecutablePath":null}]\r\n')).toEqual([{ ProcessId: 1, ExecutablePath: null }])
  })

  it('listInstallDirProcesses roda o comando e devolve o filtro; saída ilegível vira erro claro', async () => {
    const calls: string[] = []
    const run = async (command: string): Promise<string> => {
      calls.push(command)
      return `[{"ProcessId":5,"ExecutablePath":"${ROOT.replace(/\\/g, '\\\\')}\\\\resources\\\\windows-control\\\\helper.exe"},{"ProcessId":9,"ExecutablePath":"C:\\\\x.exe"}]`
    }
    expect(await listInstallDirProcesses(ROOT, 1, null, run, 'win32')).toEqual([
      { pid: 5, path: `${ROOT}\\resources\\windows-control\\helper.exe` }
    ])
    expect(calls).toEqual([LIST_PROCESSES_COMMAND])
    await expect(listInstallDirProcesses(ROOT, 1, null, async () => 'não é json', 'win32')).rejects.toThrow('ilegível')
    await expect(listInstallDirProcesses(ROOT, 1, null, run, 'linux')).rejects.toThrow('só existe no Windows')
  })

  it('killProcessTree usa taskkill /PID /T /F e recusa pid inválido', async () => {
    const calls: Array<[string, string[]]> = []
    await killProcessTree(4242, async (file, args) => {
      calls.push([file, args])
      return ''
    })
    expect(calls).toEqual([['taskkill', ['/PID', '4242', '/T', '/F']]])
    await expect(killProcessTree(0, async () => '')).rejects.toThrow('PID inválido')
  })
})
