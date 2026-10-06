/**
 * O clique num cartão de arquivo do Chat abre o arquivo no editor da esquerda,
 * pelo mesmo caminho do Contexto (`code.open`):
 *
 *   alterado no turno   a aba dele com o diff, e o trecho pisca (`flash`)
 *   só lido no turno    a aba de prévia (itálico), como hoje
 *   outro do projeto    inteiro e somente leitura (onBrowse): a edição que
 *                       falhou, o alterado que passou do limite de abas
 *   fora do projeto ou  um aviso na tela — o monitor não lê do disco o que
 *   com nome sensível   não veio no turno (pathGuard)
 *
 * O Write/Edit/MultiEdit de um .html do Agent (isAgentHtml) abre também a
 * Prévia da página, à vista (`page`) — a mesma abertura do clique no agente
 * que acabou de criar um (openInEditor).
 *
 * Abrir deixa de seguir o Agent (regra do useCodeApp). O objeto é estável (lê
 * o estado de agora por ref): o contexto não re-renderiza os cartões à toa.
 */
import { useMemo, useRef } from 'react'
import { baseName } from '../../components/toolDescribe'
import { toolFilePath, type ToolFileOpen } from '../../components/toolFileOpen'
import { isAgentHtml } from '../agentHtml'
import { diskReadVerdict, normalizePath } from './pathGuard'
import type { CodeAppState } from './useCodeApp'
import type { MonitorToast } from './useMonitorToasts'

export interface ChatFileOpenInput {
  code: Pick<CodeAppState, 'changedItems' | 'reads' | 'open' | 'onBrowse'>
  cwd: string
  /** O arquivo alterado abriu: o trecho dele pisca no editor. */
  flash: (key: string) => void
  toast: (t: MonitorToast) => void
  /** Abre a Prévia do HTML, à vista. */
  page: (path: string) => void
}

/** As ferramentas que escrevem o .html (a Prévia abre junto). */
const HTML_WRITERS = new Set(['Write', 'Edit', 'MultiEdit'])

/** Abre o arquivo no editor e, com `withPage`, a Prévia dele à vista. false: não abriu (o aviso já saiu). */
export function openInEditor(input: ChatFileOpenInput, path: string, withPage: boolean): boolean {
  const { code, cwd, flash, toast } = input
  const key = normalizePath(path)
  const verdict = diskReadVerdict(path, cwd)
  const name = baseName(path) || 'o arquivo'
  if (code.changedItems.some((t) => t.key === key)) {
    code.open(key)
    // Com a Prévia à vista o código não aparece: nada a piscar.
    if (!withPage || verdict !== 'ok') flash(key)
  } else if (code.reads.some((t) => t.key === key)) {
    code.open(key)
  } else if (verdict === 'ok') {
    code.onBrowse(path)
  } else {
    toast({
      id: 'open-file', kind: 'warn', icon: 'alert', app: 'code',
      title: `Não dá para abrir ${name}`,
      body: verdict === 'sensitive' ? 'Arquivo sensível: o monitor não mostra o conteúdo dele.' : 'Fica fora da pasta do projeto e não veio no turno.'
    })
    return false
  }
  if (!withPage) return true
  // A página só abre de dentro da pasta da conversa (o protocolo agent-mockup): o código abriu, a Prévia não.
  if (verdict !== 'ok') {
    toast({ id: 'open-file', kind: 'warn', icon: 'alert', app: 'code', title: `Sem prévia de ${name}`, body: 'A prévia só abre o HTML de dentro da pasta do projeto.' })
    return true
  }
  input.page(path)
  return true
}

export function useChatFileOpen(input: ChatFileOpenInput): ToolFileOpen {
  const ref = useRef(input)
  ref.current = input
  return useMemo<ToolFileOpen>(
    () => ({
      open: (m) => {
        const path = toolFilePath(m)
        if (path) openInEditor(ref.current, path, HTML_WRITERS.has(m.name) && isAgentHtml(path))
      }
    }),
    []
  )
}
