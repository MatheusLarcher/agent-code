/**
 * Dublê dos testes de tela da Central (não é teste): um `CentralController` de
 * mentira com entradas, trilho e perguntas fixos e as ações como `vi.fn`.
 */
import { vi } from 'vitest'
import type { CentralEntry } from '@shared/central'
import type { UIMessage } from '../types'
import { centralColor } from './centralColor'
import type { CentralLabel } from './centralRecents'
import type { CentralController, CentralPendingQuestion, CentralRailCard } from './useCentral'

/** Destinos conhecidos: convId → projeto/título (o resto, "conversa" sem projeto). */
export const DESTS: Record<string, { project: string; title: string; sandbox?: boolean; icon?: string | null }> = {
  darj: { project: 'gerar_darj', title: 'Filtro de CNPJ' },
  sso: { project: 'agent-code', title: 'Tela de login com SSO' },
  dolar: { project: 'sandbox', title: 'Cotação do dólar', sandbox: true },
  e3d: { project: 'agent-code', title: 'Escritório 3D' }
}

export function fakeLabel(convId: string): CentralLabel {
  const d = DESTS[convId]
  const color = centralColor(convId)
  if (!d) return { project: '', title: 'conversa', color, icon: null, sandbox: false }
  return { project: d.project, title: d.title, color, icon: d.icon ?? null, sandbox: d.sandbox === true }
}

export function railCard(convId: string): CentralRailCard {
  return { convId, ...fakeLabel(convId) }
}

export interface FakeInit {
  entries?: CentralEntry[]
  rail?: CentralRailCard[]
  pending?: CentralPendingQuestion[]
  tools?: Record<string, UIMessage[]>
}

export function fakeController(init: FakeInit = {}) {
  const controller = {
    entries: init.entries ?? [],
    rail: init.rail ?? [],
    pending: init.pending ?? [],
    send: vi.fn(async () => undefined),
    choose: vi.fn(async () => undefined),
    notHere: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    openDestination: vi.fn(),
    turnTools: vi.fn((a: { convId: string; msgId: string }) => init.tools?.[`${a.convId}:${a.msgId}`] ?? []),
    labelFor: vi.fn(fakeLabel)
  } satisfies CentralController
  return controller
}
