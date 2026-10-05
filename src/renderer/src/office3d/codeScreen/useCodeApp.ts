/**
 * O estado do app Código do monitor: as abas dos arquivos alterados (buildTabs,
 * como sempre), os lidos do turno e a aba de prévia, o terminal, o código ao
 * vivo, o arquivo à vista no editor e o "seguir o Agent".
 *
 * Todos os arquivos: o arquivo aberto na árvore do projeto (onBrowse) que o
 * Agent não tocou vira a aba de prévia, inteiro e somente leitura.
 *
 * Seguir o Agent: a aba é a do arquivo que ele digita agora; parado, a do último
 * arquivo que ele tocou — alterado ou LIDO (o lido abre na aba de prévia, uma
 * só, trocada pela próxima leitura). Digitando, o arquivo digitado vence. Clicar
 * num arquivo (ou rolar o código) deixa de seguir.
 *
 * O lido vem do disco (useDiskText, só dentro do projeto e sem nome sensível)
 * ou, fora do projeto, do próprio resultado do Read quando ele chegou inteiro.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { baseName } from '../../components/toolDescribe'
import type { UIMessage } from '../../types'
import type { ToolUseMessage } from '../chatPage'
import { buildTurnActions, type TurnActions } from './actionsModel'
import { buildTerminal, MAX_TABS, SCAN_MAX, writerPath } from './codeModel'
import { fileView, type FileView } from './fileView'
import { useDiskText, useLiveBlocks } from './hooks'
import { extOf } from './icons'
import type { TabItem } from './parts'
import { isSensitivePath, normalizePath } from './pathGuard'
import { readFileView, readSummary, type ReadView } from './readView'
import { settledPath, type LiveBlock } from './stitch'

/** Bloco ao vivo já fechado e sem o tool-use dele depois disto: o stream caiu, sai da tela. */
const LIVE_GRACE_MS = 8_000
/** Tool-uses lidos do fim para saber se o bloco ao vivo já virou mensagem. */
const LIVE_SCAN = 200
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READERS = new Set(['Read', 'NotebookRead'])

/**
 * O bloco ao vivo que a tela mostra: o mais novo ainda sem o tool-use final (fechado, só por um
 * tempo) e com o caminho já inteiro — o cortado dos primeiros pedaços não vira aba nem leitura.
 */
function pickLive(blocks: readonly LiveBlock[], messages: readonly UIMessage[], busy: boolean): LiveBlock | null {
  if (blocks.length === 0) return null
  const arrived = new Set<string>()
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - LIVE_SCAN); i--) {
    const m = messages[i]
    if (m.kind === 'tool-use') arrived.add(m.id)
  }
  const now = Date.now()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (!settledPath(b) || arrived.has(b.toolUseId)) continue
    if (b.done && (!busy || now - b.at > LIVE_GRACE_MS)) continue
    return b
  }
  return null
}

/** O último arquivo que o Agent tocou (escreveu sem erro ou leu), do fim para o começo. */
export function latestTouch(messages: readonly UIMessage[]): { key: string; read: boolean } | null {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - SCAN_MAX); i--) {
    const m = messages[i]
    if (m.kind === 'user') return null
    if (m.kind !== 'tool-use' || m.parentToolUseId != null) continue
    if (WRITERS.has(m.name) && !m.result?.isError) {
      const p = writerPath(m.name, m.input)
      if (p) return { key: normalizePath(p), read: false }
    } else if (READERS.has(m.name)) {
      const inp = (m.input ?? {}) as Record<string, unknown>
      const p = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : ''
      if (p) return { key: normalizePath(p), read: true }
    }
  }
  return null
}

/** A última leitura de um arquivo no turno (o trecho e o texto que o Read devolveu). */
function lastReadOf(messages: readonly UIMessage[], key: string): ToolUseMessage | null {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - SCAN_MAX); i--) {
    const m = messages[i]
    if (m.kind === 'user') break
    if (m.kind !== 'tool-use' || !READERS.has(m.name)) continue
    const inp = (m.input ?? {}) as Record<string, unknown>
    const p = typeof inp.file_path === 'string' ? inp.file_path : ''
    if (p && normalizePath(p) === key) return m
  }
  return null
}

const rangeOf = (offset: number | null, limit: number | null): string | null => {
  if (offset === null && limit === null) return null
  const from = offset !== null && offset > 1 ? offset : 1
  return limit !== null ? `${from}–${from + limit - 1}` : `${from}–`
}

export interface CodeAppState {
  actions: TurnActions
  items: TabItem[]
  changedItems: TabItem[]
  reads: TabItem[]
  terminal: ReturnType<typeof buildTerminal>
  activeKey: string | null
  activePath: string | null
  activeName: string | null
  view: FileView | null
  readOnly: string | null
  typingName: string | null
  follow: boolean
  target: number
  targetKey: string
  changed: number
  /** O bloco ao vivo de agora (o cartão do Chat usa o `latest` dos blocos). */
  live: ReturnType<typeof useLiveBlocks>
  onSelect: (key: string) => void
  onToggleFollow: () => void
  onUserScroll: () => void
  /** Abre um arquivo pela chave (do Contexto ou de um aviso): para de seguir. */
  open: (key: string) => void
  /** Abre um arquivo da árvore do projeto pelo caminho absoluto: para de seguir. */
  onBrowse: (path: string) => void
}

export function useCodeApp(messages: readonly UIMessage[], opts: { convId: string | null; cwd: string; busy: boolean; visible: boolean }): CodeAppState {
  const [follow, setFollow] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)
  const [browsed, setBrowsed] = useState<{ key: string; path: string } | null>(null)
  const live = useLiveBlocks(opts.convId)

  const actions = useMemo(() => buildTurnActions(messages), [messages])
  // Abas e terminal com identidade estável enquanto o conteúdo não muda (o feed muda a cada pedaço de texto).
  const tabsSig = actions.changed.map((t) => `${t.sig}|${t.models.join(',')}`).join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabs = useMemo(() => actions.changed, [tabsSig])
  const readsSig = actions.read.map((r) => `${r.key}|${r.offset}|${r.limit}|${r.pending ? 'p' : ''}|${r.model ?? ''}`).join('\n')
  const reads = useMemo(
    (): TabItem[] => actions.read.map((r) => ({ key: r.key, path: r.path, name: r.name, status: null, typing: false, preview: true, range: rangeOf(r.offset, r.limit), models: r.model ? [r.model] : [] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readsSig]
  )
  const builtTerm = useMemo(() => buildTerminal(messages), [messages])
  const termSig = builtTerm.map((c) => `${c.id}:${c.pending ? 'p' : c.ok ? 'o' : 'e'}`).join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const terminal = useMemo(() => builtTerm, [termSig])

  const current = pickLive(live.blocks, messages, opts.busy)
  const typing = !!current && !current.done
  const livePath = (current && settledPath(current)) ?? ''
  const liveKey = livePath ? normalizePath(livePath) : null
  const changedItems = useMemo((): TabItem[] => {
    const list: TabItem[] = tabs.map((t) => ({ key: t.key, path: t.path, name: t.name, status: t.status, typing: false, models: t.models }))
    if (!liveKey) return list
    // O arquivo que o Agent digita é o toque mais recente: vai para a frente.
    const at = list.findIndex((t) => t.key === liveKey)
    const known = at >= 0 ? list.splice(at, 1)[0] : null
    list.unshift({ key: liveKey, path: known?.path ?? livePath, name: known?.name ?? baseName(livePath), status: known?.status ?? null, typing, models: known?.models ?? [] })
    return list.slice(0, MAX_TABS)
  }, [tabs, liveKey, livePath, typing])

  const touch = latestTouch(messages)
  const isChanged = (key: string | null): boolean => !!key && changedItems.some((t) => t.key === key)
  const isRead = (key: string | null): boolean => !!key && reads.some((r) => r.key === key)
  const followKey = liveKey ?? (touch && (isChanged(touch.key) || isRead(touch.key)) ? touch.key : (changedItems[0]?.key ?? null))
  const isBrowsed = (key: string | null): boolean => !!key && browsed?.key === key
  const pickedOk = picked !== null && (isChanged(picked) || isRead(picked) || isBrowsed(picked))
  const activeKey = follow ? followKey : pickedOk ? picked : (changedItems[0]?.key ?? reads[reads.length - 1]?.key ?? null)
  // A aba de prévia: o lido à vista (uma só; a próxima leitura a troca).
  const previewKey = activeKey && !isChanged(activeKey) && isRead(activeKey) ? activeKey : null
  // Ou o arquivo aberto na árvore que o Agent não tocou: inteiro, somente leitura.
  const browseKey = activeKey && !isChanged(activeKey) && !isRead(activeKey) && isBrowsed(activeKey) ? activeKey : null
  const items = useMemo((): TabItem[] => {
    const pv: TabItem | undefined = previewKey
      ? reads.find((r) => r.key === previewKey)
      : browseKey && browsed
        ? { key: browsed.key, path: browsed.path, name: baseName(browsed.path), status: null, typing: false, preview: true }
        : undefined
    return pv ? [...changedItems, pv] : changedItems
  }, [changedItems, reads, previewKey, browseKey, browsed])
  const activeRef = useRef(activeKey)
  activeRef.current = activeKey

  const activeItem = items.find((t) => t.key === activeKey) ?? null
  const activeTab = tabs.find((t) => t.key === activeKey)
  const activePath = activeItem?.path ?? null
  const readable = opts.visible && activePath && extOf(activePath) !== 'ipynb' ? activePath : null
  const disk = useDiskText(readable, opts.cwd, activeTab?.doneTools.join(',') ?? '')
  const activeLive = current && liveKey === activeKey ? current : null
  const readMsg = previewKey ? lastReadOf(messages, previewKey) : null
  const readInp = (readMsg?.input ?? {}) as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const view = useMemo((): FileView | ReadView | null => {
    if (!activeKey) return null
    if (browseKey && activePath) return readFileView({ disk, offset: null, limit: null, whole: true, sensitive: isSensitivePath(activePath) })
    if (previewKey && activePath) {
      return readFileView({ disk, offset: num(readInp.offset), limit: num(readInp.limit), result: readMsg?.result?.text ?? null, sensitive: isSensitivePath(activePath) })
    }
    return fileView({ edits: activeTab?.edits ?? [], base: activeTab?.base ?? null, disk, live: activeLive })
    // A assinatura da aba (ou a leitura) diz tudo o que a tela desenha dela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeTab?.sig, disk, activeLive, previewKey, browseKey, readMsg?.id, readMsg?.result?.text])
  // Para onde a tela vai seguindo o Agent: o cursor dele, a última edição ainda achada ou a 1ª mudança.
  const target = view ? (view.caret ? view.caret.row : view.latest >= 0 ? view.latest : view.first) : -1
  const targetKey = `${activeKey}|${view?.caret ? 'c' : 'f'}${target}|${activeTab?.sig ?? readMsg?.id ?? ''}`

  const onSelect = useCallback((key: string) => {
    setFollow(false)
    setPicked(key)
  }, [])
  const onUserScroll = useCallback(() => {
    setPicked(activeRef.current)
    setFollow(false)
  }, [])
  const onBrowse = useCallback((path: string) => {
    const key = normalizePath(path)
    setBrowsed({ key, path })
    setFollow(false)
    setPicked(key)
  }, [])
  const onToggleFollow = useCallback(() => {
    setPicked(activeRef.current)
    setFollow((f) => !f)
  }, [])

  return {
    actions,
    items,
    changedItems,
    reads,
    terminal,
    activeKey,
    activePath,
    activeName: activeItem?.name ?? null,
    view,
    readOnly: browseKey ? 'Somente leitura' : previewKey && view && 'shown' in view ? readSummary(view) : null,
    typingName: typing ? baseName(livePath) : null,
    follow,
    target,
    targetKey,
    changed: tabs.length,
    live,
    onSelect,
    onToggleFollow,
    onUserScroll,
    open: onSelect,
    onBrowse
  }
}
