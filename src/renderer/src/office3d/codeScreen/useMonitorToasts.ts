/**
 * Os avisos do monitor, no jeito das notificações do Windows: arquivo alterado,
 * pedido de permissão, contexto reenviado no meio do turno, troca de modelo e fim
 * do turno. Cada um diz para que app o clique leva (`app`, e o arquivo ou o
 * bloco). Somem sozinhos em TOAST_MS; o de permissão fica até a resposta.
 *
 * Só o que ACONTECE com a tela aberta vira aviso: ao montar, o que já está no
 * feed é marcado como visto. No máximo TOAST_MAX à vista (o mais novo em cima).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from '@shared/ipc'
import { modelDisplayName } from '@shared/modelLabel'
import { baseName, describeTool } from '../../components/toolDescribe'
import type { UIMessage } from '../../types'
import type { IconName } from './icons'
import type { MonitorApp } from './monitorPrefs'
import { normalizePath } from './pathGuard'

export const TOAST_MS = 5200
export const TOAST_MAX = 3

export interface MonitorToast {
  id: string
  kind: 'info' | 'warn' | 'ok'
  icon: IconName
  title: string
  body: string
  app: MonitorApp
  /** Código: a chave (normalizePath) do arquivo a abrir. */
  file?: string
  /** Contexto: rolar até o último reenvio. */
  resent?: boolean
  sticky?: boolean
}

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const writerPath = (m: Extract<UIMessage, { kind: 'tool-use' }>): string => {
  const inp = (m.input ?? {}) as Record<string, unknown>
  const p = m.name === 'NotebookEdit' ? inp.notebook_path : inp.file_path
  return typeof p === 'string' ? p : ''
}

export interface ToastInput {
  convId: string
  /** As mensagens da trilha que a tela mostra (principal: a conversa). */
  messages: readonly UIMessage[]
  busy: boolean
  permission: PermissionRequest | undefined
  /** Quantos arquivos e memórias o turno teve (o texto do "turno terminado"). */
  counts: { files: number; memories: number }
}

export function useMonitorToasts(input: ToastInput): { toasts: MonitorToast[]; dismiss: (id: string) => void; push: (t: MonitorToast) => void } {
  const [toasts, setToasts] = useState<MonitorToast[]>([])
  const seen = useRef<Set<string> | null>(null)
  const wasBusy = useRef(input.busy)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
    setToasts((list) => list.filter((x) => x.id !== id))
  }, [])
  const push = useCallback(
    (t: MonitorToast) => {
      setToasts((list) => [t, ...list.filter((x) => x.id !== t.id)].slice(0, TOAST_MAX))
      if (t.sticky) return
      const old = timers.current.get(t.id)
      if (old) clearTimeout(old)
      timers.current.set(t.id, setTimeout(() => dismiss(t.id), TOAST_MS))
    },
    [dismiss]
  )
  useEffect(() => {
    const all = timers.current
    return () => {
      for (const t of all.values()) clearTimeout(t)
      all.clear()
    }
  }, [])

  // Arquivo alterado e troca de modelo: só o que chega depois de a tela abrir.
  useEffect(() => {
    const keyOf = (m: UIMessage): string | null => {
      if (m.kind === 'tool-use' && m.parentToolUseId == null && WRITERS.has(m.name) && m.result && !m.result.isError) return `w:${m.id}`
      if (m.kind === 'provider-switch' && m.fromModel !== 'auto') return `s:${m.id}`
      return null
    }
    if (seen.current === null) {
      seen.current = new Set(input.messages.map(keyOf).filter((k): k is string => k !== null))
      return
    }
    for (const m of input.messages) {
      const key = keyOf(m)
      if (!key || seen.current.has(key)) continue
      seen.current.add(key)
      if (m.kind === 'tool-use') {
        const path = writerPath(m)
        const stats = describeTool(m.name, m.input).stats
        push({
          id: key, kind: 'info', icon: 'pencil', app: 'code', file: path ? normalizePath(path) : undefined,
          title: `O Agent alterou ${baseName(path) || 'um arquivo'}`,
          body: `${stats ? `+${stats.added} −${stats.removed} · ` : ''}clique para ver no Código`
        })
      } else if (m.kind === 'provider-switch') {
        const from = modelDisplayName(m.fromModel) || m.fromModel
        const to = modelDisplayName(m.model) || m.model
        push({ id: key, kind: 'info', icon: 'spark', app: 'ctx', title: `Trocou de modelo: ${from} → ${to}`, body: m.text })
      }
    }
  }, [input.messages, push])

  // Permissão: fica até a resposta.
  const permissionId = input.permission?.id ?? null
  const permissionTool = input.permission?.toolName ?? ''
  useEffect(() => {
    if (!permissionId) {
      dismiss('perm')
      return
    }
    push({
      id: 'perm', kind: 'warn', icon: 'alert', app: 'chat', sticky: true,
      title: 'O Agent precisa de você',
      body: `${permissionTool === 'AskUserQuestion' ? 'Ele fez uma pergunta' : `Ele quer usar ${permissionTool}`}. Responda no Chat.`
    })
  }, [permissionId, permissionTool, push, dismiss])

  // Fim do turno.
  const { files, memories } = input.counts
  useEffect(() => {
    const was = wasBusy.current
    wasBusy.current = input.busy
    if (!was || input.busy) return
    const parts = [`${files} ${files === 1 ? 'arquivo alterado' : 'arquivos alterados'}`]
    if (memories > 0) parts.push(`${memories} ${memories === 1 ? 'memória' : 'memórias'}`)
    push({ id: `end:${Date.now()}`, kind: 'ok', icon: 'check', app: 'ctx', title: 'Turno terminado', body: parts.join(' · ') })
  }, [input.busy, files, memories, push])

  // Contexto reenviado no meio do turno (aviso leve do main, sem ler o snapshot).
  const convId = input.convId
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.onContextTurnsChanged !== 'function') return
    return api.onContextTurnsChanged((e) => {
      if (e.convId !== convId || !e.resent) return
      push({ id: `resent:${e.turnId}`, kind: 'info', icon: 'layers', app: 'ctx', resent: true, title: 'Contexto reenviado no meio do turno', body: 'Algo mudou nos docs ou nas memórias; o bloco foi junto de novo.' })
    })
  }, [convId, push])

  return { toasts, dismiss, push }
}
