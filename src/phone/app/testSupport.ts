/**
 * Apoio dos testes de tela (só os `*.test.tsx` importam): filiais reais pelo pcs.ts, o "APK"
 * simulado por `window.Capacitor` e o reset do que as telas leem (navegação, avisos, cliente).
 */
import type { PairConfig } from '../core/config'
import { loadPcs, renamePc, setActivePc, upsertPc } from '../core/pcs'
import { client, nav, toasts } from './runtime'

export const CASA: PairConfig = { base: 'https://relay.casa', token: 'tCasa', lan: '192.168.0.10:8765' }
export const EMPRESA: PairConfig = { base: 'https://relay.empresa', token: 'tEmpresa', lan: '' }
export const MATRIZ: PairConfig = { base: 'http://10.0.0.5:8765', token: 'tMatriz', lan: '10.0.0.5:8765' }

/** Estado limpo: armazenamento vazio (e o espelho `pcsStore` com ele), navegação, avisos e cliente. */
export function resetApp(): void {
  localStorage.clear()
  loadPcs() // sem nada salvo: devolve a lista vazia e zera o `pcsStore`
  delete window.Capacitor
  nav.set({ statusMenuOpen: false, settingsOpen: false, scanOpen: false })
  toasts.set({ list: [] })
  client.store.set({ online: false, base: '', token: '', pairingDetail: '', pairingStatus: '', blockedName: '' })
}

/** Liga/desliga o "APK": o Android injeta `window.Capacitor` no WebView. */
export function setApk(on: boolean): void {
  if (on) window.Capacitor = {}
  else delete window.Capacitor
}

/** Salva uma filial pelo caminho normal da API; `nome` null = sem apelido ("PC N"). Devolve o id. */
export function savePc(cfg: PairConfig, nome: string | null, lastUsedAt: number): string {
  const { pc } = upsertPc(cfg, lastUsedAt)
  if (nome) renamePc(pc.id, nome)
  loadPcs() // como ao abrir o app: o `pcsStore` passa a ter a filial ativa (sem escolha, a usada mais recentemente)
  return pc.id
}

/** Casa (ativa, usada em 300) e Empresa (usada em 200), a partir do armazenamento limpo. */
export function twoPcs(): { casa: string; empresa: string } {
  const casa = savePc(CASA, 'Casa', 100)
  const empresa = savePc(EMPRESA, 'Empresa', 200)
  setActivePc(casa, 300)
  return { casa, empresa }
}
