/**
 * O que o escritório consome do App. Só REFERÊNCIAS ao estado que o App.tsx já
 * guarda — nada de cópia profunda: a aba passa os mesmos objetos do useState.
 *
 * De onde vem cada campo (App.tsx, linhas aproximadas):
 *   conversations        ← useState conversations (~492)
 *   activeId             ← useState activeId (~493)
 *   busyIds              ← useState busyIds (~519)
 *   busySince            ← useState busySince (~522)
 *   permissions          ← useState permissions (~526)
 *   vigiaAlerts          ← useState vigiaAlerts (~535)
 *   vigiaAt              ← useState vigiaAt (~538)
 *   poDiagnostics        ← useState poDiagnostics (~541)
 *   memoristaDiagnostics ← useState memoristaDiagnostics (~544)
 *   observersOn          ← useState observersOn (~547)
 *   stalledSince         ← useState stalledSince (~556)
 *   tracks               ← useState tracks (~578)
 *   projectIcons         ← useState projectIcons (~3346)
 *   usageLimits          ← useState usageLimits (~555): janelas de limite, globais (F4·4-5)
 *   speakingId           ← useState speakingId (~615): mensagem sendo lida em voz (F4·4-5)
 *
 * A troca de conta (account-switch) NÃO tem estado próprio no App: o reducer
 * (onEvent, ~902) grava `claudeAccountId` na conversa e o evento entra em
 * `conversation.messages` como UIMessage kind 'account-switch' (reduceMessages,
 * ~461). O escritório lê de lá. O mesmo vale para o limite da conversa: o
 * 'error' com usageExhausted fica em messages.
 */
import type { MemoristaProviderDiagnosticMsg, PermissionRequest, PoProviderDiagnosticMsg, RateLimitStatus } from '@shared/ipc'
import type { TrackMap } from '../../agentTracks'
import type { VigiaDoubt } from '../../components/VigiaChip'
import type { Conversation } from '../../types'

export interface OfficeFeed {
  conversations: readonly Conversation[]
  activeId: string | null
  busyIds: ReadonlySet<string>
  busySince: Readonly<Record<string, number>>
  permissions: Readonly<Record<string, PermissionRequest>>
  vigiaAlerts: Readonly<Record<string, VigiaDoubt>>
  vigiaAt: Readonly<Record<string, number>>
  poDiagnostics: Readonly<Record<string, PoProviderDiagnosticMsg>>
  memoristaDiagnostics: Readonly<Record<string, MemoristaProviderDiagnosticMsg>>
  observersOn: Readonly<{ po: boolean; vigia: boolean; memorista: boolean }>
  stalledSince: Readonly<Record<string, number>>
  tracks: Readonly<Record<string, TrackMap>>
  projectIcons: Readonly<Record<string, string | null>>
  /** Opcional: feeds antigos (testes, devFeed) não trazem. */
  usageLimits?: Readonly<Record<string, RateLimitStatus>>
  speakingId?: string | null
}
