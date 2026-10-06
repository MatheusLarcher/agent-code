/**
 * A regra de "esquecer" uma filial, compartilhada pelo menu da pílula (StatusMenu), pela tela Reconectando
 * (ConnectScreens) e pelas Configurações (FiliaisCard). Não é visual: por isso mora aqui, e não num arquivo de componente.
 */
import { activePc, loadPcs, pcLabel, type PcList } from '../core/pcs'
import { client, nav } from './runtime'

/** O rótulo da ação de esquecer: com filial ativa salva, "Esquecer esta filial"; sem (navegador aberto por /app/?token=), "Sair desta conexão". */
export function forgetLabel(list: PcList): string {
  return activePc(list) ? 'Esquecer esta filial' : 'Sair desta conexão'
}

/**
 * Pede confirmação e esquece uma filial. `id`: a filial pedida; omitido: a ativa; `null`: a conexão que não é uma
 * filial salva (navegador). Roda num clique, não no render — e nunca como `onClick={confirmForget}`, que passaria o evento.
 * Depois do ok fecha o menu e, se a filial era a ativa (o app recarrega ou volta ao QR), as Configurações; esquecer uma
 * filial inativa deixa o painel aberto, que é onde elas são gerenciadas.
 */
export function confirmForget(id?: string | null): void {
  const list = loadPcs()
  const target = id === null ? null : id === undefined ? activePc(list) : list.pcs.find((p) => p.id === id)
  if (target === undefined) return // essa filial não está (mais) salva: nada a esquecer
  const question = target ? `Esquecer a filial ${pcLabel(target, list)}? Para voltar a ela, escaneie o QR dela de novo.` : 'Sair desta conexão?'
  if (!window.confirm(question)) return
  const inactive = target !== null && target.id !== list.activeId
  nav.set(inactive ? { statusMenuOpen: false } : { statusMenuOpen: false, settingsOpen: false })
  client.forgetPc(target?.id ?? null)
}
