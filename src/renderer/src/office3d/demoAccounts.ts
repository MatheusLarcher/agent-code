/**
 * As contas Claude da demonstração (Ctrl+Alt+Shift+D) — 3 conectadas com
 * leituras diferentes, para ver o banco de baterias (a pílula do HUD e o
 * quadro de energia da parede) em todos os estados sem login real:
 *
 *   Pessoal  a janela de 5 h faz o ciclo da demo (demoUsage: cheia → economia
 *            → alerta → apagão → reset); as conversas dos projetos 1 a 4 e a
 *            Central gastam dela — é a conta em destaque quase o loop todo;
 *   Empresa  18% restantes, com o projeto 5 trabalhando nela antes do apagão ("em uso");
 *   Reserva  cheia e parada, com a leitura velha ("atualizado há 12 min").
 *
 * A troca: a Pessoal esgota em USAGE_OUT_AT e, DEMO_SWITCH_MS depois, as
 * conversas dela passam para a Reserva (como a troca automática de conta faz)
 * — a Reserva assume o destaque e a luz volta antes do reset; no reset
 * (USAGE_BACK_AT) elas voltam para a Pessoal, recarregada.
 */
import type { ClaudeAccountView } from '@shared/claudeAccounts'
import type { RateLimitStatus } from '@shared/ipc'
import { USAGE_BACK_AT, USAGE_OUT_AT } from './demoTimeline'

export const DEMO_ACCOUNT = { pessoal: 'default', empresa: 'demo-empresa', reserva: 'demo-reserva' } as const
/** Quanto do apagão passa antes da troca para a Reserva. */
export const DEMO_SWITCH_MS = 20_000
/** O projeto (índice da sala da demo) que trabalha na Empresa. */
const EMPRESA_ROOM = 4

/** A conta de uma conversa da sala `room` no instante `t` do loop (a Central e o Manager são `room` = -1). */
export function demoAccountOf(room: number, t: number): string {
  if (t >= USAGE_OUT_AT + DEMO_SWITCH_MS && t < USAGE_BACK_AT) return DEMO_ACCOUNT.reserva
  // A sala da Empresa gasta dela só antes do apagão (com a Pessoal bem mais ocupada); depois, da Pessoal —
  // senão, com a Pessoal parada, a Empresa (18%) assumiria o destaque e a demo perderia o apagão.
  if (room === EMPRESA_ROOM && t < USAGE_OUT_AT) return DEMO_ACCOUNT.empresa
  return DEMO_ACCOUNT.pessoal
}

const window = (used: number, resetsAt: number | null): { utilization: number; resetsAt: number | null } => ({ utilization: Math.round(used * 1000) / 10, resetsAt })

/** As 3 contas no instante `t` do loop (`pessoal` = a janela de 5 h da demo, a mesma do usageLimits). */
export function demoAccounts(pessoal: RateLimitStatus, clock: number): ClaudeAccountView[] {
  const base = { plan: 'max', rateLimitTier: null, status: 'connected' as const }
  const used = pessoal.status === 'rejected' ? 1 : (pessoal.utilization ?? 0)
  return [
    {
      ...base,
      id: DEMO_ACCOUNT.pessoal,
      label: 'Pessoal',
      email: 'pessoal@exemplo.dev',
      isDefault: true,
      usage: { at: clock, windows: { five_hour: window(used, pessoal.resetsAt ?? null), seven_day: window(0.41, clock + 3 * 86_400_000) } }
    },
    {
      ...base,
      id: DEMO_ACCOUNT.empresa,
      label: 'Empresa',
      email: 'time@empresa.dev',
      isDefault: false,
      usage: { at: clock - 40_000, windows: { five_hour: window(0.82, clock + 2 * 3_600_000 + 15 * 60_000), seven_day: window(0.63, clock + 5 * 86_400_000) } }
    },
    {
      ...base,
      id: DEMO_ACCOUNT.reserva,
      label: 'Reserva',
      email: 'reserva@exemplo.dev',
      isDefault: false,
      usage: { at: clock - 12 * 60_000, windows: { five_hour: window(0, null), seven_day: window(0.08, clock + 6 * 86_400_000) } }
    }
  ]
}
