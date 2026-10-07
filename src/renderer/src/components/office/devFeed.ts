/**
 * Feed sintético para medir o custo do escritório (só DEV): 5 salas com 4
 * conversas cada = 20 personagens principais, metade ocupada, alguns com
 * pedido de permissão. Determinístico.
 */
import { contextLimitFor, type BackgroundTask, type PermissionRequest } from '@shared/ipc'
import { PROJECT_RESERVE_PALETTE, type ProjectColorMap } from '@shared/projectColor'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { Conversation } from '../../types'

export const DEV_ROOMS = 5
export const DEV_PER_ROOM = 4

export function syntheticFeed(now: number = Date.now()): OfficeFeed {
  const conversations: Conversation[] = []
  const busyIds = new Set<string>()
  const busySince: Record<string, number> = {}
  const permissions: Record<string, PermissionRequest> = {}
  // Uma cor por sala, espalhada pela paleta (como se o PC já tivesse detectado).
  const projectColors: ProjectColorMap = {}
  for (let r = 0; r < DEV_ROOMS; r++) {
    projectColors[`C:\\dev\\projeto-${r + 1}`] = { hex: PROJECT_RESERVE_PALETTE[(r * 5) % PROJECT_RESERVE_PALETTE.length], source: 'reserva' }
    for (let i = 0; i < DEV_PER_ROOM; i++) {
      const id = `dev-${r}-${i}`
      conversations.push({
        id,
        title: `Sintética ${r + 1}.${i + 1}`,
        cwd: `C:\\dev\\projeto-${r + 1}`,
        model: 'claude-opus-4-5',
        sdkSessionId: null,
        messages: [],
        // F4·4-5: a 2ª de cada sala liga a impressora e a pilha de papéis (90%).
        tokens: { context: i === 1 ? Math.round(contextLimitFor('claude-opus-4-5') * 0.92) : 0, output: 0, cost: 0 },
        ...(i === 1 ? { backgroundTasks: [{ id: `bg-${id}`, type: 'local_bash', description: 'npm run dev' } satisfies BackgroundTask] } : {}),
        createdAt: now - 60_000,
        updatedAt: now - 1_000
      })
      if (i % 2 === 0) {
        busyIds.add(id)
        busySince[id] = now - 5_000
      }
      if (i === 3 && r % 2 === 0) {
        permissions[id] = { id: `perm-${id}`, toolName: 'Bash', input: { command: 'npm test' } } as unknown as PermissionRequest
      }
    }
  }
  return {
    conversations,
    activeId: conversations[0].id,
    busyIds,
    busySince,
    permissions,
    vigiaAlerts: {},
    vigiaAt: {},
    poDiagnostics: {},
    memoristaDiagnostics: {},
    observersOn: { po: false, vigia: false, memorista: false },
    stalledSince: {},
    tracks: {},
    projectIcons: {},
    projectColors
  }
}
