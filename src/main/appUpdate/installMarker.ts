// Marcador da instalação em curso: gravado logo antes de o instalador subir e
// lido na abertura seguinte. Versão igual à do app = atualizou; diferente = o
// instalador não concluiu (o NSIS restaura a pasta antiga em silêncio) e o
// serviço registra isso no log — sem o marcador, uma atualização que falhou
// seria indistinguível de uma que nunca foi pedida.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const INSTALL_MARKER_FILENAME = 'atualizacao-em-curso.json'

export interface InstallMarker {
  version: string
  at: string
}

/** Nunca lança: o marcador é diagnóstico, não pode segurar a instalação. */
export function writeInstallMarker(file: string, version: string, now: () => Date = () => new Date()): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const marker: InstallMarker = { version, at: now().toISOString() }
    writeFileSync(file, JSON.stringify(marker), 'utf8')
  } catch {
    /* diagnóstico */
  }
}

/** Lê e apaga o marcador; null quando não há (ou está ilegível). */
export function readAndClearInstallMarker(file: string): InstallMarker | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstallMarker>
    unlinkSync(file)
    if (typeof raw?.version !== 'string' || !raw.version) return null
    return { version: raw.version, at: typeof raw.at === 'string' ? raw.at : '' }
  } catch {
    try {
      unlinkSync(file)
    } catch {
      /* já não existe */
    }
    return null
  }
}

/** A frase do log na abertura seguinte à instalação. */
export function describeInstallOutcome(marker: InstallMarker, currentVersion: string): string {
  return marker.version === currentVersion
    ? `atualização concluída: o app está na ${currentVersion}`
    : `a instalação anterior (${marker.version}, pedida em ${marker.at || '?'}) não concluiu; o app continua na ${currentVersion} e a próxima verificação baixa de novo se preciso`
}
