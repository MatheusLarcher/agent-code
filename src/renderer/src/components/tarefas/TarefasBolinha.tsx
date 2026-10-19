import { useEffect, useMemo, useRef, useState } from 'react'
import { resumoDaConversa, type TarefaAcao, type TarefaVista, type Validado } from '@shared/tarefas'
import { useUI } from '../../ui/UiProvider'
import { IconAlarm, IconBell, IconClose, IconPause, IconTask } from '../Icons'
import { TarefaItem } from './TarefaItem'
import { classesDaBolinha, dicaDoResumo, iconeDoResumo } from './tarefasTexto'
import './tarefas.css'

export type TarefaAcaoFn = (id: string, acao: TarefaAcao) => Promise<Validado<TarefaVista | null>>

/** Ordem estável do popover (não pula enquanto checa ou ao marcar visto): monitores,
 *  lembretes, pausadas; dentro de cada grupo, a mais antiga primeiro. */
function grupo(t: TarefaVista): number {
  if (t.estado === 'pausada') return 2
  return t.tipo === 'monitor' ? 0 : 1
}
function ordem(a: TarefaVista, b: TarefaVista): number {
  return grupo(a) - grupo(b) || a.criadaEm.localeCompare(b.criadaEm) || a.id.localeCompare(b.id)
}

/**
 * A bolinha de tarefas no canto do chat (PC e celular) e o popover que abre
 * dela. Recebe as tarefas da conversa (o main é a fonte da verdade) e a função
 * da ação; abrir o popover marca o "bateu" como visto. Esc e clique fora fecham.
 */
export function TarefasBolinha({
  tarefas,
  acao,
  celular = false,
  agora = Date.now
}: {
  tarefas: readonly TarefaVista[]
  acao: TarefaAcaoFn
  celular?: boolean
  agora?: () => number
}): JSX.Element | null {
  const ui = useUI()
  const [aberto, setAberto] = useState(false)
  const [expandida, setExpandida] = useState<string | null>(null)
  const [ocupadas, setOcupadas] = useState<ReadonlySet<string>>(new Set())
  const confirmando = useRef(false)
  const dotRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const convId = tarefas[0]?.convId ?? ''
  const resumo = useMemo(() => (convId ? resumoDaConversa(convId, tarefas) : null), [convId, tarefas])
  const lista = useMemo(() => [...tarefas].sort(ordem), [tarefas])

  // Esc e clique fora fecham — menos com o modal de cancelar aberto (ele é "fora").
  // Fechado, nenhuma tarefa fica expandida: reabrir mostra a lista recolhida.
  useEffect(() => {
    if (!aberto) {
      setExpandida(null)
      return
    }
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !confirmando.current) setAberto(false)
    }
    const fora = (e: Event): void => {
      if (confirmando.current) return
      const alvo = e.target as Node | null
      if (alvo && (popRef.current?.contains(alvo) || dotRef.current?.contains(alvo))) return
      setAberto(false)
    }
    document.addEventListener('keydown', tecla)
    document.addEventListener('pointerdown', fora, true)
    return () => {
      document.removeEventListener('keydown', tecla)
      document.removeEventListener('pointerdown', fora, true)
    }
  }, [aberto])

  // Aberto: o "bateu" de cada tarefa conta como visto (o verde da bolinha some).
  const naoVistas = tarefas.filter((t) => t.bateuNaoVistoEm).map((t) => t.id).join(',')
  useEffect(() => {
    if (!aberto || !naoVistas) return
    for (const id of naoVistas.split(',')) void acao(id, 'visto').catch(() => undefined)
  }, [aberto, naoVistas, acao])

  if (!resumo) return null

  const rodar = async (id: string, qual: TarefaAcao): Promise<boolean> => {
    setOcupadas((s) => new Set(s).add(id))
    try {
      const r = await acao(id, qual)
      if (!r.ok) ui.notify('erro', r.erro)
      return r.ok
    } catch (error) {
      ui.notify('erro', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setOcupadas((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }

  const cancelar = async (t: TarefaVista): Promise<void> => {
    confirmando.current = true
    let ok = false
    try {
      ok = await ui.confirm({
        title: t.tipo === 'lembrete' ? 'Cancelar o lembrete?' : 'Cancelar a tarefa?',
        message: t.tipo === 'lembrete' ? 'Ele não toca mais e sai da bolinha.' : 'Ela para de checar e sai da bolinha.',
        confirmLabel: t.tipo === 'lembrete' ? 'Cancelar lembrete' : 'Cancelar tarefa',
        cancelLabel: 'Voltar',
        danger: true
      })
    } finally {
      // O clique que fechou o modal não pode fechar o popover junto.
      setTimeout(() => (confirmando.current = false), 0)
    }
    if (ok && (await rodar(t.id, 'cancelar'))) ui.notify('sucesso', t.tipo === 'lembrete' ? 'Lembrete cancelado.' : 'Tarefa cancelada.')
  }

  const icone = iconeDoResumo(resumo)
  const agoraMs = agora()
  return (
    <>
      <button
        ref={dotRef}
        type="button"
        className={`${classesDaBolinha(resumo)}${celular ? ' celular' : ''}`}
        data-tip={dicaDoResumo(resumo)}
        aria-label={dicaDoResumo(resumo)}
        aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}
      >
        {icone === 'bell' ? <IconBell /> : icone === 'alarm' ? <IconAlarm /> : icone === 'pause' ? <IconPause /> : <IconTask />}
        {resumo.total > 1 && <span className="n">{resumo.total}</span>}
      </button>
      {aberto && (
        <div ref={popRef} className={`tpop${celular ? ' celular' : ''}`} role="dialog" aria-label="Tarefas desta conversa">
          <div className="tpop-h">
            Tarefas desta conversa
            <button type="button" className="x" aria-label="Fechar" onClick={() => setAberto(false)}>
              <IconClose size={13} />
            </button>
          </div>
          {lista.map((t) => (
            <TarefaItem
              key={t.id}
              t={t}
              aberta={expandida === t.id}
              ocupada={ocupadas.has(t.id)}
              agora={agoraMs}
              onAlternar={() => setExpandida((id) => (id === t.id ? null : t.id))}
              onPausar={() => void rodar(t.id, t.estado === 'pausada' ? 'retomar' : 'pausar')}
              onCancelar={() => void cancelar(t)}
            />
          ))}
        </div>
      )}
    </>
  )
}
