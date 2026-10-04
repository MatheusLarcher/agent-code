/**
 * Os dois ganchos de dados do editor do monitor:
 *
 *   useLiveBlocks(convId)   o código ao vivo do agente principal (liveInput),
 *                           costurado por bloco (stitch). Assina só enquanto a
 *                           tela existe; no máximo LIVE_FLUSH_MS entre dois
 *                           renders (o 1º pedaço e o `done` vão na hora).
 *   useDiskText(path, …)    o arquivo da aba no disco, pelo window.api.readFile
 *                           que já existe — só caminho absoluto dentro do cwd e
 *                           sem nome sensível (pathGuard). Guarda por caminho e
 *                           relê quando chega resultado novo de ferramenta no
 *                           arquivo (`refresh`), mostrando o texto anterior até
 *                           a releitura voltar.
 */
import { useEffect, useRef, useState } from 'react'
import { liveInput, type ToolInputDelta } from '../../office/liveInput'
import { normalizeDiskText, type DiskState } from './fileView'
import { diskReadVerdict, normalizePath } from './pathGuard'
import { stitch, type LiveBlock } from './stitch'

/** Intervalo mínimo entre dois renders do código ao vivo (≤ 10 por segundo). */
export const LIVE_FLUSH_MS = 100
/** Bloco fechado some da memória depois disto (o tool-use final já chegou ou não vem mais). */
const DONE_KEEP_MS = 30_000
/** Acima disto (caracteres) o arquivo não é aberto: só os trechos. */
export const DISK_MAX = 1_500_000

export interface LiveState {
  /** Blocos costurados, do mais antigo ao mais novo. */
  blocks: readonly LiveBlock[]
  /** O último evento ainda aberto (o cartão ao vivo do Chat). */
  latest: ToolInputDelta | undefined
}

const NO_LIVE: LiveState = { blocks: [], latest: undefined }

export function useLiveBlocks(convId: string | null): LiveState {
  const [state, setState] = useState<LiveState>(NO_LIVE)
  useEffect(() => {
    setState(NO_LIVE)
    if (!convId) return
    const blocks = new Map<string, LiveBlock>()
    let latest: ToolInputDelta | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    let flushedAt = -Infinity
    const flush = (): void => {
      timer = null
      flushedAt = Date.now()
      setState({ blocks: [...blocks.values()], latest })
    }
    const onDelta = (d: ToolInputDelta): void => {
      const now = Date.now()
      const prev = blocks.get(d.toolUseId)
      blocks.delete(d.toolUseId) // reinserido no fim: a ordem do Map é a do mais recente
      blocks.set(d.toolUseId, stitch(prev, d, now))
      for (const [id, b] of blocks) if (b.done && now - b.at > DONE_KEEP_MS) blocks.delete(id)
      if (!d.done) latest = d
      else if (latest?.toolUseId === d.toolUseId) latest = undefined
      if (timer !== null) return
      const wait = LIVE_FLUSH_MS - (now - flushedAt)
      if (wait <= 0 || d.done || !prev) flush()
      else timer = setTimeout(flush, wait)
    }
    const open = liveInput.latest(convId, null)
    if (open) onDelta(open)
    const off = liveInput.subscribe(convId, null, onDelta)
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [convId])
  return state
}

interface CacheEntry {
  refresh: string
  state: DiskState
}

const ERROR_PREFIX = 'Erro ao ler arquivo:'

/** O arquivo da aba ativa no disco (ver o topo). `refresh` = as ferramentas concluídas no arquivo. */
export function useDiskText(path: string | null, cwd: string, refresh: string): DiskState {
  const cache = useRef(new Map<string, CacheEntry>())
  const [, setVersion] = useState(0)
  const verdict = path ? diskReadVerdict(path, cwd) : 'relative'
  const api = typeof window !== 'undefined' ? window.api : undefined
  const canRead = !!path && verdict === 'ok' && typeof api?.readFile === 'function'
  // O mesmo arquivo escrito com barra ou caixa diferente (C:/a vs c:\A) é uma entrada só.
  const key = path ? normalizePath(path) : ''

  useEffect(() => {
    if (!canRead || !path) return
    const hit = cache.current.get(key)
    if (hit && hit.refresh === refresh && hit.state.kind !== 'none') return
    let alive = true
    const reflected = new Set(refresh ? refresh.split(',') : [])
    api!
      .readFile(path)
      .then((res) => {
        if (!alive) return
        let state: DiskState
        if (typeof res !== 'string') state = { kind: 'none', reason: 'error' }
        else if (res.startsWith(ERROR_PREFIX)) state = /ENOENT/.test(res) ? { kind: 'missing' } : { kind: 'none', reason: 'error' }
        else if (res.length > DISK_MAX) state = { kind: 'none', reason: 'large' }
        else state = { kind: 'text', text: normalizeDiskText(res), reflected }
        cache.current.set(key, { refresh, state })
        setVersion((v) => v + 1)
      })
      .catch(() => {
        if (!alive) return
        cache.current.set(key, { refresh, state: { kind: 'none', reason: 'error' } })
        setVersion((v) => v + 1)
      })
    return () => {
      alive = false
    }
    // `api` é o window.api do app (fixo); `key` acompanha `path`. Só caminho, permissão e releitura contam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, refresh, canRead])

  if (!path) return NONE.unavailable
  if (verdict !== 'ok') return NONE[verdict]
  if (!canRead) return NONE.unavailable
  // Releitura em curso: fica o texto anterior (sem piscar); a 1ª leitura, "lendo".
  return cache.current.get(key)?.state ?? NONE.loading
}

const NONE = {
  relative: { kind: 'none', reason: 'relative' },
  outside: { kind: 'none', reason: 'outside' },
  sensitive: { kind: 'none', reason: 'sensitive' },
  unavailable: { kind: 'none', reason: 'unavailable' },
  loading: { kind: 'none', reason: 'loading' }
} as const satisfies Record<string, DiskState>
