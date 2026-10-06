/**
 * O que a tela do monitor lembra entre aberturas, F5 e reinício — no
 * localStorage, com chaves `agentcode.*` como o resto do app:
 *
 *   app        o último app aberto (Código, Contexto); 1ª vez, o `initialMode`.
 *              O 'chat' de antes (o app Chat deixou de existir: o chat mora no
 *              Código) é lido como Código
 *   pinned     a barra de tarefas fixa
 *   coach      a dica "leve o mouse até a borda" já foi vista (some para sempre)
 *   chatWidth  a largura do Chat no Código (px), a mesma para todos os monitores
 *
 * Armazenamento indisponível (modo privado, cota) não quebra a tela: lê o
 * padrão e a gravação é ignorada.
 */
export type MonitorApp = 'code' | 'ctx'

export const MONITOR_APPS: readonly MonitorApp[] = ['code', 'ctx']

const KEY_APP = 'agentcode.monitor.app'
const KEY_PINNED = 'agentcode.monitor.pinned'
const KEY_COACH = 'agentcode.monitor.coachSeen'
const KEY_CHAT_W = 'agentcode.monitor.chatWidth'

/** O Chat do Código (px): o padrão, o mínimo, o editor que sobra no máximo e a fração da tela. */
export const CHAT_DEFAULT_W = 400
export const CHAT_MIN_W = 280
export const CHAT_EDITOR_MIN_W = 320
export const CHAT_MAX_RATIO = 0.6

/**
 * O máximo do Chat numa tela de `screenW` px com `fixedLeft` px fixos à
 * esquerda (barra de atividades, explorador e a borda): 60% da tela, sem deixar
 * o editor com menos de 320 px; abaixo do mínimo vale o mínimo. Tela não
 * medida (0): sem teto.
 */
export function maxChatWidth(screenW: number, fixedLeft: number): number {
  if (!(screenW > 0)) return Infinity
  return Math.max(CHAT_MIN_W, Math.floor(Math.min(screenW * CHAT_MAX_RATIO, screenW - fixedLeft - CHAT_EDITOR_MIN_W)))
}

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
    if (v === 'chat') return 'code'
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
  },
  /** A largura guardada (px, nunca abaixo do mínimo); sem nada ou lixo, o padrão. */
  chatWidth(): number {
    const n = Number(read(KEY_CHAT_W))
    return Number.isFinite(n) && n > 0 ? Math.max(CHAT_MIN_W, Math.round(n)) : CHAT_DEFAULT_W
  },
  setChatWidth(width: number): void {
    if (Number.isFinite(width) && width > 0) write(KEY_CHAT_W, String(Math.round(width)))
  }
}
