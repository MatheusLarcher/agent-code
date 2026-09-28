import { MEDIA_MARKER_SOURCE } from '../../shared/inlineMedia'

/**
 * Campos da conversa que são DESTE dispositivo, nunca da conversa compartilhada
 * no PostgreSQL: a pasta local (`cwd`), o rascunho do campo (`draft`) e os
 * anexos desse rascunho (`draftMedia`, que guarda caminhos do disco local).
 * Cada máquina tem o seu; a outra nem vê nem apaga.
 *
 * Um só lugar para o gravar normal, a migração SQLite -> PostgreSQL e o fork de
 * sessão divergente: os três separavam só `cwd`/`draft` à mão.
 */
export const DEVICE_CONVERSATION_FIELDS = ['cwd', 'draft', 'draftMedia'] as const

export function splitDeviceFields<T extends Record<string, unknown>>(
  payload: T
): { shared: T; device: Record<string, unknown> } {
  const shared: Record<string, unknown> = { ...payload }
  const device: Record<string, unknown> = {}
  if (typeof shared.cwd === 'string') device.cwd = shared.cwd
  if (typeof shared.draft === 'string') device.draft = shared.draft
  if (Array.isArray(shared.draftMedia)) device.draftMedia = shared.draftMedia
  for (const field of DEVICE_CONVERSATION_FIELDS) delete shared[field]
  return { shared: shared as T, device }
}

const MARKER = new RegExp(MEDIA_MARKER_SOURCE)

/**
 * Leitura: o compartilhado + o estado deste dispositivo. `draftMedia` do
 * compartilhado é legado (gravado antes da separação) e não é herdado por
 * outra máquina; só vale para quem tem, no PRÓPRIO rascunho, os marcadores
 * `{{midia:N}}` e nenhuma lista própria — o dono daquele rascunho.
 */
export function mergeDeviceState<T extends Record<string, unknown>>(
  shared: T,
  device: Record<string, unknown>
): T {
  const { draftMedia: legacyMedia, ...rest } = shared as Record<string, unknown>
  const merged: Record<string, unknown> = { ...rest, ...device }
  if (
    !Array.isArray(device.draftMedia) &&
    Array.isArray(legacyMedia) &&
    typeof device.draft === 'string' &&
    MARKER.test(device.draft)
  ) {
    merged.draftMedia = legacyMedia
  }
  return merged as T
}
