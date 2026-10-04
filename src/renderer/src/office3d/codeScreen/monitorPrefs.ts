/**
 * O que a tela do monitor lembra entre aberturas, F5 e reinício — no
 * localStorage, com chaves `agentcode.*` como o resto do app:
 *
 *   app       o último app aberto (Código, Chat, Contexto); 1ª vez, Chat
 *   pinned    a barra de tarefas fixa
 *   coach     a dica "leve o mouse até a borda" já foi vista (some para sempre)
 *
 * Armazenamento indisponível (modo privado, cota) não quebra a tela: lê o
 * padrão e a gravação é ignorada.
 */
export type MonitorApp = 'code' | 'chat' | 'ctx'

export const MONITOR_APPS: readonly MonitorApp[] = ['code', 'chat', 'ctx']

const KEY_APP = 'agentcode.monitor.app'
const KEY_PINNED = 'agentcode.monitor.pinned'
const KEY_COACH = 'agentcode.monitor.coachSeen'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* sem armazenamento: vale só nesta abertura */
  }
}

export function isMonitorApp(value: unknown): value is MonitorApp {
  return typeof value === 'string' && (MONITOR_APPS as readonly string[]).includes(value)
}

export const monitorPrefs = {
  app(): MonitorApp | null {
    const v = read(KEY_APP)
    return isMonitorApp(v) ? v : null
  },
  setApp(app: MonitorApp): void {
    write(KEY_APP, app)
  },
  pinned(): boolean {
    return read(KEY_PINNED) === '1'
  },
  setPinned(on: boolean): void {
    write(KEY_PINNED, on ? '1' : '0')
  },
  coachSeen(): boolean {
    return read(KEY_COACH) === '1'
  },
  setCoachSeen(): void {
    write(KEY_COACH, '1')
  }
}
