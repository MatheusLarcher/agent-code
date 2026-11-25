/**
 * "Reportar bug / sugerir melhoria" (Configurações): o resumo técnico que vai
 * junto do relato do usuário. Só dados do app e da máquina que ajudam a achar
 * o problema — versão, Windows, modo da GPU e as últimas quedas da tela. Nada
 * de conversa, caminho de projeto, conta ou senha.
 */
import { readFile } from 'node:fs/promises'
import { arch, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { Channels, type FeedbackDiagnostico } from '../shared/ipc'
import { describeGpuLevel, readGpuMode } from './gpuSafeMode'

/** Quantas linhas finais do tela.log entram no relatório. */
export const SCREEN_LOG_LINES = 12

/** Últimas linhas não vazias; cada uma cortada para não estourar o link. */
export function lastLines(text: string, count = SCREEN_LOG_LINES): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-count)
    .map((l) => l.slice(0, 200))
}

export async function buildFeedbackDiagnostico(userDataDir: string): Promise<FeedbackDiagnostico> {
  const log = await readFile(join(userDataDir, 'logs', 'tela.log'), 'utf8').catch(() => '')
  return {
    versao: app.getVersion(),
    sistema: `${process.platform === 'win32' ? 'Windows' : process.platform} ${release()} (${arch()})`,
    memoriaGb: Math.round(totalmem() / 1024 ** 3),
    gpu: describeGpuLevel(readGpuMode(userDataDir).level),
    eventosTela: lastLines(log)
  }
}

export function registerFeedbackIpc(): void {
  ipcMain.handle(Channels.feedbackDiagnostico, () => buildFeedbackDiagnostico(app.getPath('userData')))
}
