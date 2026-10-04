/**
 * As peças da janela "VS Code" do monitor, sem estado próprio além da rolagem:
 * a faixa de abas (tablist), o explorador dos arquivos que o Agent mexeu
 * (Alterados) e leu (Lidos), o painel do terminal, a barra de status e a tela
 * de boas-vindas (vazia).
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { modelSequenceLabel } from '@shared/modelLabel'
import type { TerminalCommand } from './codeModel'
import { FileGlyph, Icon } from './icons'
import { madeBy, ModelTags } from './modelTags'
import { relativePath, slashed } from './pathGuard'

export interface TabItem {
  key: string
  path: string
  name: string
  /** null: ainda não se sabe (o arquivo está sendo escrito) ou só lido. */
  status: 'U' | 'M' | null
  typing: boolean
  /** Só lido: abre como aba de prévia (nome em itálico), sem letra. */
  preview?: boolean
  /** Lido em parte: as linhas ("95–174"). */
  range?: string | null
  /** Os modelos que fizeram (as edições ou a leitura). */
  models?: readonly string[]
}

const statusWord = (t: TabItem): string => (t.typing ? 'digitando' : t.status === 'U' ? 'novo' : t.status === 'M' ? 'modificado' : t.preview ? 'lido' : '')
const named = (t: TabItem): string => [t.name, statusWord(t)].filter(Boolean).join(', ')

function Marker({ t }: { t: TabItem }): JSX.Element | null {
  if (t.typing) return <span className="cm-typing" aria-hidden="true" />
  if (!t.status) return null
  return (
    <span className={`cm-badge cm-badge-${t.status}`} aria-hidden="true">
      {t.status}
    </span>
  )
}

export interface TabStripProps {
  tabs: readonly TabItem[]
  active: string | null
  panelId: string
  tabId: (key: string) => string
  onSelect: (key: string) => void
}

export function TabStrip({ tabs, active, panelId, tabId, onSelect }: TabStripProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  // A aba ativa sempre à vista (scrollLeft da faixa; nunca scrollIntoView).
  useLayoutEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !el) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (left < list.scrollLeft) list.scrollLeft = left
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth
  }, [active, tabs])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.key === active)
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
    if (to === null || tabs.length === 0) return
    e.preventDefault()
    const at = (to + tabs.length) % tabs.length
    onSelect(tabs[at].key)
    ;(listRef.current?.children[at] as HTMLElement | undefined)?.focus()
  }

  return (
    <div className="cm-tabs" role="tablist" aria-label="Arquivos abertos" ref={listRef} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={tabId(t.key)}
            aria-selected={on}
            aria-controls={panelId}
            aria-label={named(t)}
            tabIndex={on ? 0 : -1}
            className={`cm-tab${on ? ' active' : ''}${t.typing ? ' typing' : ''}${t.preview ? ' cm-tab-pv' : ''}`}
            title={t.preview ? `${slashed(t.path)} · aba de prévia: a próxima leitura do Agent troca este arquivo` : slashed(t.path)}
            onClick={() => onSelect(t.key)}
          >
            <FileGlyph path={t.path} />
            <span className="cm-tab-name">{t.name}</span>
            <Marker t={t} />
          </button>
        )
      })}
    </div>
  )
}

interface Group {
  dir: string
  label: string
  files: TabItem[]
}

const OUTSIDE = '\u0000fora'

/** Os arquivos agrupados por pasta (relativa ao projeto): pastas em ordem, depois a raiz, por último o que está fora. */
export function groupByFolder(tabs: readonly TabItem[], cwd: string): Group[] {
  const groups = new Map<string, Group>()
  for (const t of tabs) {
    const rel = cwd ? relativePath(t.path, cwd) : null
    const dir = rel === null ? OUTSIDE : rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    let g = groups.get(dir)
    if (!g) {
      g = { dir, label: dir === OUTSIDE ? 'Fora do projeto' : dir, files: [] }
      groups.set(dir, g)
    }
    g.files.push(t)
  }
  const rank = (g: Group): number => (g.dir === OUTSIDE ? 2 : g.dir === '' ? 1 : 0)
  const out = [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.dir.localeCompare(b.dir))
  for (const g of out) g.files.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export interface ExplorerProps {
  project: string
  cwd: string
  /** Alterados (como hoje, até MAX_TABS). */
  tabs: readonly TabItem[]
  /** Lidos do turno, sem os alterados. */
  reads?: readonly TabItem[]
  active: string | null
  /** O turno teve mais de um modelo: cada arquivo leva a etiqueta do dele. */
  mixed?: boolean
  onOpen: (key: string) => void
}

function FileTree({ files, cwd, active, mixed, onOpen }: { files: readonly TabItem[]; cwd: string; active: string | null; mixed: boolean; onOpen: (key: string) => void }): JSX.Element {
  return (
    <>
      {groupByFolder(files, cwd).map((g) => (
        <div className="cm-group" key={g.dir}>
          {g.label && (
            <div className="cm-folder" title={g.label}>
              <Icon name="chevron" className="cm-open" />
              <Icon name="folder" />
              <span>{g.label}</span>
            </div>
          )}
          <ul className={g.label ? 'cm-in-folder' : undefined}>
            {g.files.map((t) => (
              <li key={t.key}>
                <button
                  type="button"
                  className={`cm-file${t.key === active ? ' active' : ''}${t.preview ? ' read' : ''}`}
                  aria-current={t.key === active ? 'true' : undefined}
                  aria-label={named(t)}
                  title={`${slashed(t.path)}${t.range ? ` · linhas ${t.range}` : ''}${madeBy(t.models)}`}
                  onClick={() => onOpen(t.key)}
                >
                  <FileGlyph path={t.path} />
                  <span className="cm-file-name">{t.name}</span>
                  {t.range && <span className="cm-file-range">{t.range}</span>}
                  <ModelTags models={t.models} mixed={mixed} />
                  <Marker t={t} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

export function Explorer({ cwd, tabs, reads = [], active, mixed = false, onOpen }: ExplorerProps): JSX.Element {
  return (
    <nav className="cm-explorer" aria-label="Explorador: arquivos que o Agent alterou e leu">
      <div className="cm-side-title" aria-hidden="true">
        Explorador
      </div>
      <div className="cm-section" title="Arquivos que o Agent criou ou mudou">
        <Icon name="chevron" className="cm-open" />
        <span>Alterados</span>
        <span className="cm-sec-cnt">{tabs.length}</span>
      </div>
      {tabs.length === 0 ? <p className="cm-side-empty">Nenhum arquivo alterado ainda.</p> : <FileTree files={tabs} cwd={cwd} active={active} mixed={mixed} onOpen={onOpen} />}
      <div className="cm-section" title="Arquivos que o Agent abriu e não mudou, neste turno">
        <Icon name="chevron" className="cm-open" />
        <span>Lidos</span>
        <span className="cm-sec-cnt">{reads.length}</span>
      </div>
      {reads.length === 0 ? <p className="cm-side-empty">Nenhum arquivo só lido neste turno.</p> : <FileTree files={reads} cwd={cwd} active={active} mixed={mixed} onOpen={onOpen} />}
    </nav>
  )
}

export interface TerminalPanelProps {
  commands: readonly TerminalCommand[]
  cwd: string
  project: string
}

export function TerminalPanel({ commands, cwd, project }: TerminalPanelProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [commands])
  return (
    <section className="cm-panel" aria-label="Terminal">
      <div className="cm-panel-head">
        <span className="cm-panel-tab">Terminal</span>
        <span className="cm-panel-shell">
          <Icon name="terminal" />
          {commands[commands.length - 1]?.shell === 'pwsh' ? 'pwsh' : 'bash'}
        </span>
      </div>
      <div className="cm-term" ref={bodyRef}>
        {commands.map((c) => {
          const [line, ...rest] = c.command.split('\n')
          return (
            <div className="cm-cmd" key={c.id}>
              <div className="cm-prompt">
                <span className="cm-ps">{c.shell === 'pwsh' ? `PS ${cwd || project}>` : `${project || '~'} $`}</span>
                <span className="cm-cmdline" title={c.command}>
                  {line}
                  {rest.length > 0 && <span className="cm-more-lines"> +{rest.length}</span>}
                </span>
                <span className={`cm-run ${c.pending ? 'run' : c.ok ? 'ok' : 'err'}`}>
                  {c.pending ? (
                    <>
                      <span className="cm-spin" aria-hidden="true" />
                      executando
                    </>
                  ) : c.ok ? (
                    <>
                      <Icon name="check" />
                      ok
                    </>
                  ) : (
                    <>
                      <Icon name="cross" />
                      falhou
                    </>
                  )}
                </span>
              </div>
              {c.more > 0 && <div className="cm-out cm-out-more">… {c.more === 1 ? '1 linha acima' : `${c.more} linhas acima`}</div>}
              {c.output.map((l, i) => (
                <div className="cm-out" key={i}>
                  {l || ' '}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export interface StatusBarProps {
  who: string
  typingName: string | null
  changed: number
  /** Arquivos só lidos no turno. */
  read?: number
  /** O modelo (ou a sequência) do turno, lido das respostas; [] = nada a mostrar. */
  models?: readonly string[]
  /** O esforço da sessão, para a dica do modelo. */
  effort?: string
  /** O arquivo à vista é só lido: "Somente leitura · leu as linhas …". */
  readOnly?: string | null
  follow: boolean
  onToggleFollow: () => void
  position: { ln: number; col: number } | null
  stats: { added: number; removed: number } | null
  lang: string | null
}

export function StatusBar({ who, typingName, changed, read = 0, models = [], effort = '', readOnly = null, follow, onToggleFollow, position, stats, lang }: StatusBarProps): JSX.Element {
  const sequence = modelSequenceLabel(models)
  return (
    <footer className="cm-statusbar">
      <span className="cm-remote">
        <Icon name="code" />
        Agent{who ? ` · ${who}` : ''}
      </span>
      {sequence && (
        <span className="cm-sb cm-sb-model" title={`Modelo que respondeu neste turno, lido da resposta da API${effort ? ` · esforço ${effort.toLowerCase()}` : ''}`}>
          <Icon name="spark" />
          {sequence}
        </span>
      )}
      <span className="cm-sb">
        {typingName ? (
          <>
            <span className="cm-typing" aria-hidden="true" />
            digitando {typingName}…
          </>
        ) : changed > 0 ? (
          <>
            <Icon name="check" />
            {changed === 1 ? '1 arquivo alterado' : `${changed} arquivos alterados`}
            {read > 0 ? ` · ${read} ${read === 1 ? 'lido' : 'lidos'}` : ''}
          </>
        ) : read > 0 ? (
          `Nenhum arquivo alterado · ${read} ${read === 1 ? 'lido' : 'lidos'}`
        ) : (
          'Nenhum arquivo alterado'
        )}
      </span>
      <span className="cm-sb-fill" />
      <button type="button" className="cm-sb cm-follow" aria-pressed={follow} onClick={onToggleFollow} title={follow ? 'Parar de seguir o Agent' : 'Seguir o Agent de novo'}>
        <Icon name="follow" />
        {follow ? 'Seguindo o Agent' : 'Seguir o Agent'}
      </button>
      {position && (
        <span className="cm-sb cm-sb-pos">
          Ln {position.ln}, Col {position.col}
        </span>
      )}
      {readOnly && (
        <span className="cm-sb cm-sb-ro">
          <Icon name="eye" />
          {readOnly}
        </span>
      )}
      {!readOnly && stats && (stats.added > 0 || stats.removed > 0) && (
        <span className="cm-sb cm-sb-stats" aria-label={`${stats.added} linhas adicionadas, ${stats.removed} removidas`}>
          <span className="cm-sb-add">+{stats.added}</span>
          <span className="cm-sb-del">−{stats.removed}</span>
        </span>
      )}
      {lang && <span className="cm-sb cm-sb-lang">{lang}</span>}
    </footer>
  )
}

export interface WelcomeProps {
  busy: boolean
  activity: string
  onShowChat: () => void
}

export function Welcome({ busy, activity, onShowChat }: WelcomeProps): JSX.Element {
  return (
    <div className="cm-welcome">
      <Icon name="code" className="cm-welcome-mark" />
      <h3>Nenhum arquivo editado ainda</h3>
      <p>Quando o Agent criar ou editar um arquivo, o código aparece aqui, com o que mudou em verde e vermelho.</p>
      {busy && activity && <p className="cm-welcome-now">Agora: {activity}</p>}
      <button type="button" className="cm-welcome-btn" onClick={onShowChat}>
        <Icon name="chat" />
        Ver o chat
      </button>
    </div>
  )
}
