/**
 * O app Código do monitor: a janela no jeito do VS Code — barra de atividades,
 * explorador dos arquivos que o Agent alterou e leu, abas (o lido abre na aba
 * de prévia, em itálico), trilha do caminho, o editor com o diff (o lido, sem
 * cor de diff), o painel do terminal e a barra de status na cor do Agent, com o
 * modelo que respondeu.
 *
 * Memorizado: o pai re-renderiza a cada feed (texto do chat chegando), mas esta
 * árvore só muda quando abas, arquivo, código ao vivo ou terminal mudam.
 */
import { memo, useCallback, useId, useState } from 'react'
import type { TerminalCommand } from './codeModel'
import { EditorPane } from './EditorPane'
import type { FileView } from './fileView'
import { FileGlyph, Icon, langName } from './icons'
import { Explorer, StatusBar, TabStrip, TerminalPanel, Welcome, type TabItem } from './parts'
import { relativePath, slashed } from './pathGuard'

export interface CodeViewProps {
  /** As abas: as dos alterados e, no fim, a de prévia do arquivo só lido. */
  items: readonly TabItem[]
  /** Os alterados (o Explorador) e os lidos do turno. */
  changedItems: readonly TabItem[]
  reads: readonly TabItem[]
  /** O modelo (ou a sequência) do turno, o esforço e se o turno é misto (etiquetas). */
  models: readonly string[]
  effort: string
  mixed: boolean
  /** O arquivo à vista é só lido: o texto da barra de status. */
  readOnly: string | null
  activeKey: string | null
  activePath: string | null
  view: FileView | null
  terminal: readonly TerminalCommand[]
  cwd: string
  project: string
  /** Subagente: o papel ("executor"); principal: vazio. */
  who: string
  busy: boolean
  /** O que o Agent está fazendo agora (o rótulo do personagem). */
  activity: string
  typingName: string | null
  changed: number
  follow: boolean
  /** Linha que a tela acompanha e a chave que pede a rolagem até ela. */
  target: number
  targetKey: string
  onSelect: (key: string) => void
  onToggleFollow: () => void
  onUserScroll: () => void
  onShowChat: () => void
}

function Crumbs({ path, cwd }: { path: string; cwd: string }): JSX.Element {
  const rel = (cwd && relativePath(path, cwd)) || slashed(path)
  const parts = rel.split('/').filter(Boolean)
  const name = parts.pop() ?? rel
  return (
    <div className="cm-crumbs" title={slashed(path)}>
      {parts.map((p, i) => (
        <span className="cm-crumb" key={i}>
          {p}
          <Icon name="chevron" className="cm-crumb-sep" />
        </span>
      ))}
      <span className="cm-crumb cm-crumb-file">
        <FileGlyph path={path} />
        {name}
      </span>
    </div>
  )
}

export const CodeView = memo(function CodeView(p: CodeViewProps): JSX.Element {
  const uid = useId()
  const [sidebar, setSidebar] = useState(true)
  const panelId = `${uid}-editor`
  const keys = p.items.map((t) => t.key)
  const tabId = useCallback((key: string): string => `${uid}-tab-${keys.indexOf(key)}`, [uid, keys.join('\n')])
  // Ln/Col: o cursor do Agent ou a 1ª linha numerada a partir de onde a tela está (o alvo de seguir).
  const at = p.view && p.target >= 0 ? p.view.rows.slice(p.target).find((r) => r.num !== null) : undefined
  const position = p.view?.caret?.ln != null ? { ln: p.view.caret.ln, col: p.view.caret.col } : at?.num != null ? { ln: at.num, col: 1 } : null

  return (
    <div className="cm-body">
      <div className="cm-workbench">
        <nav className="cm-activity" aria-label="Barra de atividades">
          <button type="button" className={`cm-act${sidebar ? ' on' : ''}`} aria-pressed={sidebar} aria-label="Explorador" title="Explorador" onClick={() => setSidebar((s) => !s)}>
            <Icon name="files" />
          </button>
          <span className="cm-act" aria-hidden="true">
            <Icon name="search" />
          </span>
          <span className="cm-act" aria-hidden="true">
            <Icon name="branch" />
            {p.changed > 0 && <span className="cm-act-badge">{p.changed}</span>}
          </span>
          <span className="cm-act" aria-hidden="true">
            <Icon name="blocks" />
          </span>
          <span className="cm-act-fill" />
          <span className="cm-act cm-act-agent" aria-hidden="true">
            <Icon name="agent" />
          </span>
        </nav>
        {sidebar && <Explorer project={p.project} cwd={p.cwd} tabs={p.changedItems} reads={p.reads} mixed={p.mixed} active={p.activeKey} onOpen={p.onSelect} />}
        <div className="cm-main">
          {p.items.length > 0 && p.activeKey && p.activePath ? (
            <>
              <TabStrip tabs={p.items} active={p.activeKey} panelId={panelId} tabId={tabId} onSelect={p.onSelect} />
              <Crumbs path={p.activePath} cwd={p.cwd} />
              <div className="cm-tabpanel" role="tabpanel" id={panelId} aria-labelledby={tabId(p.activeKey)}>
                {/* Uma montagem por arquivo: abre rolado até a mudança dele, não na rolagem do anterior. */}
                {p.view && <EditorPane key={p.activeKey} path={p.activePath} view={p.view} target={p.target} targetKey={p.targetKey} follow={p.follow} onUserScroll={p.onUserScroll} />}
              </div>
            </>
          ) : (
            <Welcome busy={p.busy} activity={p.activity} onShowChat={p.onShowChat} />
          )}
          {p.terminal.length > 0 && <TerminalPanel commands={p.terminal} cwd={p.cwd} project={p.project} />}
        </div>
      </div>
      <StatusBar
        who={p.who}
        typingName={p.typingName}
        changed={p.changed}
        read={p.reads.length}
        models={p.models}
        effort={p.effort}
        readOnly={p.readOnly}
        follow={p.follow}
        onToggleFollow={p.onToggleFollow}
        position={position}
        stats={p.view ? { added: p.view.added, removed: p.view.removed } : null}
        lang={p.activePath ? langName(p.activePath) : null}
      />
    </div>
  )
})
