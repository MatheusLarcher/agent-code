/**
 * O app Contexto do monitor: o que o Agent RECEBEU (o que o app enviou, copiado
 * na origem, e o que o motor carrega medido pelo SDK) e o que ele FEZ no turno,
 * com o modelo que fez cada coisa.
 *
 * Dados: o histórico do contexto pelo IPC do PC (useContextTurns — só lê com
 * este app aberto) e as mensagens da conversa (ou a trilha do subagente) para o
 * "Fez". Seletor com os 10 últimos turnos, cada um com o modelo (ou a sequência).
 * Turno de outro PC sem as mensagens aqui: o aviso de onde foi capturado.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContextTurnSummary, ContextUsageSnapshot } from '@shared/contextSnapshot'
import { modelSequenceLabel } from '@shared/modelLabel'
import type { UIMessage } from '../../types'
import { allContextText, contextBlocks, contextTotals, countHits, fmtTokens, kb, type DisplayBlock } from './contextView'
import { copyText, RecvBlock, XRay } from './ContextRecv'
import { didOfTurn, segmentForTurn, type DidMemory, type TurnDid } from './didModel'
import { Icon, type IconName } from './icons'
import { distinctModels, madeBy, ModelChip, ModelTags } from './modelTags'
import type { MonitorToast } from './useMonitorToasts'
import { useContextTurns } from './useContextTurns'

const hm = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const actionCount = (d: TurnDid): number => d.reads.length + d.other.reduce((n, g) => n + g.items.length, 0)
/** O pedido do usuário (e o do principal, no subagente) nasce aberto. */
const openByDefault = (id: string): boolean => /^(prompt|subagent):(user-request|subagent-request):/.test(id)

export interface ContextAppProps {
  convId: string | null
  /** As mensagens da conversa (principal) ou da trilha (subagente). */
  messages: readonly UIMessage[]
  /** Monitor de um subagente: o turno e o tool-use que o abriu. */
  subagent?: { parentToolUseId: string; turnId: string | null } | null
  memoriesDir: string | null
  /** Sobe a cada pedido de "ir ao último reenvio" (o aviso). */
  focusResent?: number
  onOpenFile: (key: string) => void
  onOpenChat: () => void
  onToast: (t: MonitorToast) => void
}

export function ContextApp(p: ContextAppProps): JSX.Element {
  const ctx = useContextTurns(p.convId, true, p.subagent ? { parentToolUseId: p.subagent.parentToolUseId, turnId: p.subagent.turnId } : {})
  // Blocos que o usuário abriu ou fechou ao contrário do padrão (o pedido nasce aberto).
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set())
  const handledResent = useRef(0)
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState(false)
  const [exact, setExact] = useState<ContextUsageSnapshot | null>(null)
  const [hoverMem, setHoverMem] = useState(false)
  const [lit, setLit] = useState<string | null>(null)
  const [acts, setActs] = useState<string | null>(null)
  const recvRef = useRef<HTMLDivElement>(null)

  const newest = ctx.list[0]?.turnId ?? null
  const current = ctx.list.find((t) => t.turnId === ctx.selected) ?? null
  const isNewest = !ctx.selected || ctx.selected === newest
  const usage = (isNewest ? exact : null) ?? ctx.detail?.usage ?? null
  const blocks = useMemo(() => contextBlocks({ detail: ctx.detail, newer: ctx.newer, usage, subagent: !!p.subagent }), [ctx.detail, ctx.newer, usage, p.subagent])
  const totals = contextTotals(blocks, usage)
  // Fez: o trecho de mensagens do turno escolhido (o atual sem turno gravado ainda).
  const segment = useMemo(
    () => (p.subagent ? p.messages : segmentForTurn(p.messages, ctx.selected ?? (ctx.list.length ? newest : null))),
    [p.messages, p.subagent, ctx.selected, ctx.list.length, newest]
  )
  const did = useMemo(
    () => didOfTurn(segment ?? [], { memoriesDir: p.memoriesDir, memoriesSent: ctx.detail?.memoriesSent ?? null }),
    [segment, p.memoriesDir, ctx.detail?.memoriesSent]
  )
  // O modelo que fez: o que o main gravou por resposta; sem ele (turno antigo), o das ações.
  const turnModels = useMemo(() => {
    const recorded = distinctModels((ctx.detail?.models ?? []).map((m) => m.model))
    return recorded.length ? recorded : did.models
  }, [ctx.detail?.models, did.models])
  const mixed = turnModels.length > 1
  const sameAs = ctx.newer ? hm(ctx.newer.startedAt) : null

  // Exata vale para o turno em que foi pedida.
  useEffect(() => setExact(null), [ctx.selected, newest])
  // O aviso "contexto reenviado": abre e mostra o último reenvio (uma vez por aviso;
  // o bloco pode chegar só na releitura).
  useEffect(() => {
    if (!p.focusResent || handledResent.current === p.focusResent) return
    const last = [...blocks].reverse().find((b) => b.when !== undefined)
    if (!last) return
    handledResent.current = p.focusResent
    openBlock(last.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusResent, blocks])

  const isOpen = (id: string): boolean => flipped.has(id) !== openByDefault(id)
  function openBlock(id: string): void {
    setFlipped((s) => {
      const next = new Set(s)
      if (openByDefault(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setLit(id)
    requestAnimationFrame(() => {
      const col = recvRef.current
      const el = col ? [...col.querySelectorAll<HTMLElement>('[data-id]')].find((x) => x.dataset.id === id) : undefined
      if (col && el) col.scrollTop = Math.max(0, el.offsetTop - 44)
    })
    setTimeout(() => setLit((x) => (x === id ? null : x)), 900)
  }
  const toggle = (id: string): void =>
    setFlipped((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const copy = (text: string): void => {
    const done = (): void => p.onToast({ id: `copy:${Date.now()}`, kind: 'ok', icon: 'copy', app: 'ctx', title: 'Copiado', body: `${kb(new Blob([text]).size)} na área de transferência.` })
    void navigator.clipboard?.writeText(text).then(done, () => undefined)
  }
  const countExact = async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!p.convId || typeof api?.countContextExact !== 'function') return
    const res = await api.countContextExact(p.convId).catch(() => null)
    if (res?.ok && res.usage) {
      setExact(res.usage)
      p.onToast({ id: 'exact', kind: 'ok', icon: 'check', app: 'ctx', title: 'Contagem exata feita', body: `${res.usage.totalTokens.toLocaleString('pt-BR')} tokens, pela API de contagem.` })
    } else {
      p.onToast({ id: 'exact', kind: 'warn', icon: 'alert', app: 'ctx', title: 'Contagem exata indisponível', body: res?.reason ?? 'Mostrando o resumo do SDK.' })
    }
  }
  const hits = blocks.reduce((n, b) => n + countHits(b.text, q), 0)
  const onSearch = (value: string): void => {
    setQ(value)
    const first = value.trim() && blocks.find((b) => countHits(b.text, value))
    if (first) openBlock(first.id)
  }

  const empty = ctx.unavailable
    ? 'O histórico do contexto não está disponível aqui.'
    : !ctx.loading && ctx.list.length === 0 && !p.subagent
      ? 'Nenhum turno gravado nesta conversa ainda. O contexto aparece aqui a partir do próximo pedido.'
      : !ctx.loading && !ctx.detail
        ? p.subagent
          ? 'O contexto deste subagente não foi gravado (ele começou antes desta tela existir ou em outra sessão).'
          : 'Este turno não tem contexto gravado.'
        : null

  return (
    <div className="cm-ctxapp">
      <div className="cm-ctx-top">
        {p.subagent ? (
          <span className="cm-turnbtn static">
            <Icon name="users" />
            Tarefa delegada
          </span>
        ) : (
          <button type="button" className="cm-turnbtn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="history" />
            {current ? `Turno das ${hm(current.startedAt)}${isNewest ? ' · atual' : ''}` : 'Turnos'}
            <Icon name="chevron-down" />
          </button>
        )}
        <div className="cm-ctx-sum">
          {ctx.detail ? (
            <>
              <b>{fmtTokens(totals.tokens, !!exact && isNewest)} tokens</b>
              <i>·</i>app enviou <b>{kb(totals.appBytes)}</b>
              <i>·</i>
              <b>{did.files.length}</b> {did.files.length === 1 ? 'alterado' : 'alterados'}
              <i>·</i>
              <b>{did.memories.length}</b> {did.memories.length === 1 ? 'memória' : 'memórias'}
              <i>·</i>
              <b>{actionCount(did)}</b> {actionCount(did) === 1 ? 'ação' : 'ações'}
            </>
          ) : ctx.loading ? (
            'Lendo…'
          ) : (
            'Esperando o próximo pedido.'
          )}
        </div>
        <label className="cm-search">
          <Icon name="search" />
          <input type="search" placeholder="Buscar no que ele recebeu" aria-label="Buscar no contexto recebido" value={q} onChange={(e) => onSearch(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Escape' && q) {
              e.stopPropagation()
              setQ('')
            }
          }} />
          {q.trim() && <span className="cm-cnt">{hits}</span>}
        </label>
        <button type="button" className="cm-btn" disabled={!isNewest || !!p.subagent || !!exact || !ctx.detail} title="Conta cada parte com a API de contagem de tokens (grátis, limite próprio)" onClick={() => void countExact()}>
          <Icon name="check" />
          {exact && isNewest ? 'Contado' : 'Contar exato'}
        </button>
        <button type="button" className="cm-btn" disabled={!blocks.some((b) => b.text !== undefined)} onClick={() => copy(allContextText(blocks))}>
          <Icon name="copy" />
          Copiar tudo
        </button>
      </div>
      {menu && !p.subagent && <TurnMenu list={ctx.list} selected={ctx.selected} messages={p.messages} onPick={(id) => { ctx.select(id === newest ? null : id); setMenu(false) }} />}
      <div className="cm-ctx-body">
        <XRay blocks={blocks} q={q} lit={hoverMem ? (blocks.find((b) => b.memory)?.id ?? null) : lit} onOpen={openBlock} />
        <div className="cm-col cm-recv" ref={recvRef}>
          <div className="cm-col-h">
            <Icon name="recv" />
            <span className="cm-eyebrow">Recebeu</span>
            <span className="cm-hint">{p.subagent ? 'as instruções e o pedido que este subagente recebeu' : 'tudo o que entrou no contexto do Agent, na ordem em que ele lê'}</span>
          </div>
          {ctx.detail && !isNewest && (
            <div className="cm-old-banner">
              <Icon name="history" />
              Turno das {hm(ctx.detail.startedAt)}, lido do banco. Blocos marcados &quot;igual&quot; têm o mesmo texto do turno seguinte e foram guardados uma vez só.
            </div>
          )}
          {ctx.detail && segment === null && (
            <div className="cm-old-banner">
              <Icon name="info" />
              Contexto capturado no PC {ctx.detail.pc}. As mensagens deste turno não estão carregadas aqui.
            </div>
          )}
          {empty && <p className="cm-empty">{empty}</p>}
          {blocks.map((b) => (
            <RecvBlock
              key={b.id}
              block={b}
              open={isOpen(b.id)}
              q={q}
              exact={!!exact && isNewest}
              sameAs={sameAs}
              linked={hoverMem && !!b.memory}
              secrets={ctx.detail?.secrets ?? []}
              onToggle={toggle}
              onCopy={(x: DisplayBlock) => copy(copyText(x))}
              onOpenChat={p.onOpenChat}
            />
          ))}
          {blocks.length > 0 && (
            <div className="cm-foot">
              O app copia o que ele mesmo envia ao Agent; o resto vem da medição do SDK. Todos os turnos ficam gravados no banco do app; a tela mostra os 10 últimos. Senhas nunca são gravadas: o olho lê o cofre na hora.
            </div>
          )}
        </div>
        <DidColumn
          did={did}
          models={turnModels}
          mixed={mixed}
          when={!isNewest && ctx.detail ? hm(ctx.detail.startedAt) : null}
          acts={acts}
          onActs={(k) => setActs((x) => (x === k ? null : k))}
          onOpenFile={p.onOpenFile}
          onHoverSent={setHoverMem}
        />
      </div>
    </div>
  )
}

function TurnMenu({ list, selected, messages, onPick }: { list: readonly ContextTurnSummary[]; selected: string | null; messages: readonly UIMessage[]; onPick: (id: string) => void }): JSX.Element {
  const rows = useMemo(
    () =>
      list.map((t, i) => {
        const seg = segmentForTurn(messages, t.turnId)
        const d = seg ? didOfTurn(seg) : null
        const models = distinctModels(t.models.map((m) => m.model))
        return { t, i, d, models: models.length ? models : (d?.models ?? []) }
      }),
    [list, messages]
  )
  return (
    <div className="cm-turnmenu" role="menu" aria-label="Turnos desta conversa">
      {rows.map(({ t, i, d, models }) => (
        <button key={t.turnId} type="button" className="cm-ti3" role="menuitem" aria-current={(selected ?? list[0]?.turnId) === t.turnId} onClick={() => onPick(t.turnId)}>
          <span className="cm-tm">{hm(t.startedAt)}</span>
          <span className="cm-tx3" title={t.request}>{t.request || '(sem texto)'}</span>
          <span className="cm-ct">
            {d ? `${plural(d.files.length, 'alterado', 'alterados')} · ${plural(actionCount(d), 'ação', 'ações')}` : `PC ${t.pc}`}
            {models.length > 0 && (
              <>
                {' · '}
                <span className="cm-tmm">{modelSequenceLabel(models)}</span>
              </>
            )}
            {i === 0 ? ' · atual' : ''}
          </span>
        </button>
      ))}
      <div className="cm-tm-foot">Os 10 últimos turnos desta conversa, com o modelo que fez cada um. Todos ficam gravados no banco do app.</div>
    </div>
  )
}

const MEM_TAG: Record<DidMemory['tag'], string> = { sent: 'enviada', read: 'lida', saved: 'gravada' }
const MEM_ICON: Record<DidMemory['tag'], IconName> = { sent: 'chip', read: 'eye', saved: 'save' }
const GROUP_ICON: Record<string, IconName> = { reads: 'eye', search: 'search', command: 'terminal', web: 'globe', 'memory-query': 'chip', delegate: 'users' }

interface DidColumnProps {
  did: TurnDid
  models: readonly string[]
  mixed: boolean
  when: string | null
  acts: string | null
  onActs: (k: string) => void
  onOpenFile: (key: string) => void
  onHoverSent: (on: boolean) => void
}

function Bars({ added, removed }: { added: number; removed: number }): JSX.Element {
  const total = Math.max(1, added + removed)
  const green = Math.round((added / total) * 5)
  return (
    <span className="cm-bars" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < green ? 'a' : added + removed ? 'd' : ''} />
      ))}
    </span>
  )
}

function DidColumn({ did, models, mixed, when, acts, onActs, onOpenFile, onHoverSent }: DidColumnProps): JSX.Element {
  const groups = [
    ...(did.reads.length ? [{ key: 'reads', label: 'Leituras', n: did.reads.length }] : []),
    ...did.other.map((g) => ({ key: g.kind as string, label: g.label, n: g.items.length }))
  ]
  const selected = acts === 'reads' ? null : did.other.find((g) => g.kind === acts)
  return (
    <div className="cm-col cm-did">
      <div className="cm-col-h">
        <Icon name="pencil" />
        <span className="cm-eyebrow">Fez</span>
        <span className="cm-hint">{when ? `no turno das ${when}` : 'o que ele mudou a partir disso'}</span>
        <ModelChip models={models} />
      </div>
      <div className="cm-grp">
        <div className="cm-grp-h">
          <Icon name="file" />
          Arquivos alterados<span className="cm-n">{did.files.length}</span>
        </div>
        {did.files.length === 0 && <div className="cm-empty">Nenhum arquivo alterado.</div>}
        {did.files.map((f) => (
          <button key={f.key} type="button" className="cm-did-row" title={`Abrir no Código${madeBy(f.models)}`} onClick={() => onOpenFile(f.key)}>
            <Icon name={f.status === 'U' ? 'file' : 'pencil'} />
            <span className="cm-did-main">
              <span className="cm-nm">{f.name}</span>
              <span className="cm-pth">{f.path.replace(/\\/g, '/').split('/').slice(0, -1).slice(-4).join('/')}</span>
            </span>
            <span className="cm-r">
              <ModelTags models={f.models} mixed={mixed} />
              <span className="cm-pm">
                <span className="a">+{f.added}</span> <span className="d">−{f.removed}</span>
              </span>
              <Bars added={f.added} removed={f.removed} />
              <span className={`cm-st ${f.status}`}>{f.status}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="cm-grp">
        <div className="cm-grp-h">
          <Icon name="chip" />
          Memórias<span className="cm-n">{did.memories.length}</span>
        </div>
        {did.memories.length === 0 && <div className="cm-empty">Nenhuma memória neste turno.</div>}
        {did.memories.map((m, i) => {
          const path = m.relPath.replace(/\\/g, '/')
          const name = path.split('/').pop() ?? path
          const dir = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : 'memórias/'
          const model = m.tag === 'sent' ? undefined : m.model
          return (
            <div
              key={`${m.tag}:${path}:${i}`}
              className="cm-did-row static"
              data-tag={m.tag}
              title={m.tag === 'sent' ? 'O app pôs esta memória nos trechos que o Agent recebeu.' : m.tag === 'read' ? `O Agent abriu o arquivo desta memória${madeBy(model ? [model] : [])}.` : `O Agent salvou esta memória${madeBy(model ? [model] : [])}.`}
              onMouseEnter={m.tag === 'sent' ? () => onHoverSent(true) : undefined}
              onMouseLeave={m.tag === 'sent' ? () => onHoverSent(false) : undefined}
            >
              <Icon name={MEM_ICON[m.tag]} />
              <span className="cm-did-main">
                <span className="cm-nm">{name.replace(/\.md$/u, '')}</span>
                <span className="cm-pth">{dir}</span>
              </span>
              <span className="cm-r">
                {model && <ModelTags models={[model]} mixed={mixed} />}
                <span className={`cm-tag ${m.tag}`}>{MEM_TAG[m.tag]}</span>
              </span>
            </div>
          )
        })}
      </div>
      <div className="cm-grp">
        <div className="cm-grp-h">
          <Icon name="layers" />
          Outras ações<span className="cm-n">{actionCount(did)}</span>
        </div>
        {groups.length === 0 ? (
          <div className="cm-empty">Nada.</div>
        ) : (
          <div className="cm-chips">
            {groups.map((g) => (
              <button key={g.key} type="button" className="cm-chip" aria-pressed={acts === g.key} onClick={() => onActs(g.key)}>
                <Icon name={GROUP_ICON[g.key] ?? 'layers'} />
                {g.label} <b>{g.n}</b>
              </button>
            ))}
          </div>
        )}
        {acts === 'reads' && (
          <ul className="cm-act-list">
            {did.reads.map((r) => (
              <li key={r.key}>
                <button type="button" className="cm-lnk" title="Abrir no Código" onClick={() => onOpenFile(r.key)}>
                  {r.path.replace(/\\/g, '/')}
                </button>{' '}
                {r.offset !== null || r.limit !== null ? <span className="cm-dim">trecho</span> : null} <ModelTags models={r.model ? [r.model] : []} mixed={mixed} />
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <ul className="cm-act-list">
            {selected.items.map((x) => (
              <li key={x.id} className={x.error ? 'err' : undefined}>
                {x.summary || x.tool}
                {x.error && <span className="cm-dim"> · erro</span>} <ModelTags models={x.model ? [x.model] : []} mixed={mixed} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
