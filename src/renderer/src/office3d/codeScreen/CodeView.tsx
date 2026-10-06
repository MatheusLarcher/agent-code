/**
 * O app Código do monitor: a janela no jeito do VS Code — barra de atividades,
 * explorador dos arquivos que o Agent alterou e leu, abas (o lido abre na aba
 * de prévia, em itálico), trilha do caminho, o editor com o diff (o lido, sem
 * cor de diff) e o painel do terminal. O .html do Agent tem a aba "Prévia:
 * x.html" logo depois da do código (htmlPreview.ts): à vista, a página
 * (PreviewPane) fica no lugar do editor; o olho no canto da faixa a abre. O
 * Chat fica à direita (ChatDock) e a barra de status na cor do Agent, com o
 * modelo que respondeu, cobre os dois (CodeStatus, montada pelo CodeMonitor).
 *
 * Memorizado: o pai re-renderiza a cada feed (texto do chat chegando), mas esta
 * árvore só muda quando abas, arquivo, código ao vivo ou terminal mudam.
 */
import { memo, useCallback, useId, useMemo, useState } from 'react'
import { isAgentHtml } from '../agentHtml'
import type { TerminalCommand } from './codeModel'
import { EditorPane } from './EditorPane'
import type { FileView } from './fileView'
import { PAGE_TAB, withPageTabs, type PageTab } from './htmlPreview'
import { FileGlyph, Icon, langName } from './icons'
import { Explorer, StatusBar, TabStrip, TerminalPanel, Welcome, type TabItem } from './parts'
import { diskReadVerdict, relativePath, slashed } from './pathGuard'
import { PreviewPane } from './PreviewPane'
import type { CodeAppState } from './useCodeApp'

export interface CodeViewProps {
  /** As abas: as dos alterados e, no fim, a de prévia do arquivo só lido. */
  items: readonly TabItem[]
  /** Os alterados (o Explorador) e os lidos do turno. */
  changedItems: readonly TabItem[]
  reads: readonly TabItem[]
  /** O turno teve mais de um modelo (etiquetas). */
  mixed: boolean
  activeKey: string | null
  activePath: string | null
  view: FileView | null
  terminal: readonly TerminalCommand[]
  cwd: string
  project: string
  busy: boolean
  /** O que o Agent está fazendo agora (o rótulo do personagem). */
  activity: string
  changed: number
  follow: boolean
  /** Linha que a tela acompanha e a chave que pede a rolagem até ela. */
  target: number
  targetKey: string
  /** O arquivo aberto pelo Chat: a chave e o contador (o trecho dele pisca). */
  flash: { key: string; n: number } | null
  /** As Prévias do HTML abertas e a que está à vista (null: o código). */
  pages: readonly PageTab[]
  page: PageTab | null
  /** A última escrita do arquivo da Prévia à vista: a página recarrega quando muda. */
  pageWrite: string | null
  /** Uma aba de arquivo (ou um arquivo do Explorador): sai da Prévia. */
  onSelect: (key: string) => void
  /** A aba da Prévia de um arquivo (a chave dele). */
  onSelectPage: (key: string) => void
  /** O olho: abre a Prévia do .html à vista. */
  onOpenPage: (path: string) => void
  /** Abre um arquivo da árvore de todos os arquivos (caminho absoluto). */
  onBrowse?: (path: string) => void
  onUserScroll: () => void
  /** "Escrever no chat" da tela vazia: o campo do Chat ao lado. */
  onShowChat: () => void
  /** O explorador abriu ou fechou: a largura fixa da esquerda mudou (o teto do Chat é medido de novo). */
  onLayout?: () => void
}

function Crumbs({ path, cwd, page }: { path: string; cwd: string; page: boolean }): JSX.Element {
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
        {page ? <Icon name="globe" className="cm-glyph-page" /> : <FileGlyph path={path} />}
        {page ? `Prévia: ${name}` : name}
      </span>
    </div>
  )
}

export const CodeView = memo(function CodeView(p: CodeViewProps): JSX.Element {
  const uid = useId()
  const [sidebar, setSidebar] = useState(true)
  // Explorador: só os usados (padrão a cada montagem) ou todos; as pastas abertas valem enquanto a tela existe.
  const [onlyUsed, setOnlyUsed] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const onToggleOnlyUsed = useCallback(() => setOnlyUsed((v) => !v), [])
  const onToggleDir = useCallback((rel: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (!next.delete(rel)) next.add(rel)
      return next
    })
  }, [])
  const panelId = `${uid}-editor`
  const tabs = useMemo(() => withPageTabs(p.items, p.pages), [p.items, p.pages])
  const keys = tabs.map((t) => t.key)
  const tabId = useCallback((key: string): string => `${uid}-tab-${keys.indexOf(key)}`, [uid, keys.join('\n')])
  const page = p.page
  const activeTab = page ? PAGE_TAB + page.key : p.activeKey
  const onTab = (key: string): void => (key.startsWith(PAGE_TAB) ? p.onSelectPage(key.slice(PAGE_TAB.length)) : p.onSelect(key))
  // O olho: o .html do Agent à vista (no código), dentro do projeto — a Prévia só abre o que a pasta da conversa tem.
  const htmlPath = !page && p.activePath && isAgentHtml(p.activePath) && diskReadVerdict(p.activePath, p.cwd) === 'ok' ? p.activePath : null
  const eye = htmlPath ? (
    <button type="button" className="cm-tab-act" aria-label="Abrir prévia" title="Abrir a prévia da página numa aba, no lugar do código (como o Live Preview do VS Code)" onClick={() => p.onOpenPage(htmlPath)}>
      <Icon name="eye" />
    </button>
  ) : null

  return (
    <div className="cm-workbench">
      <nav className="cm-activity" aria-label="Barra de atividades">
        <button
          type="button"
          className={`cm-act${sidebar ? ' on' : ''}`}
          aria-pressed={sidebar}
          aria-label="Explorador"
          title="Explorador"
          onClick={() => {
            setSidebar((s) => !s)
            p.onLayout?.()
          }}
        >
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
      {sidebar && (
        <Explorer
          project={p.project}
          cwd={p.cwd}
          tabs={p.changedItems}
          reads={p.reads}
          mixed={p.mixed}
          active={page?.key ?? p.activeKey}
          onOpen={p.onSelect}
          onlyUsed={onlyUsed}
          onToggleOnlyUsed={p.onBrowse ? onToggleOnlyUsed : undefined}
          expanded={expanded}
          onToggleDir={onToggleDir}
          onBrowse={p.onBrowse}
        />
      )}
      <div className="cm-main">
        {page || (p.items.length > 0 && p.activeKey && p.activePath) ? (
          <>
            <TabStrip tabs={tabs} active={activeTab} panelId={panelId} tabId={tabId} onSelect={onTab} action={eye} />
            <Crumbs path={page?.path ?? p.activePath ?? ''} cwd={p.cwd} page={!!page} />
            <div className="cm-tabpanel" role="tabpanel" id={panelId} aria-labelledby={activeTab ? tabId(activeTab) : undefined}>
              {/* A Prévia no lugar do editor (montada só à vista); o código, uma montagem por arquivo: abre rolado até a mudança dele. */}
              {page ? (
                <PreviewPane key={page.key} cwd={p.cwd} project={p.project} path={page.path} name={page.name} writeId={p.pageWrite} />
              ) : p.view && p.activeKey && p.activePath && (
                <EditorPane
                  key={p.activeKey}
                  path={p.activePath}
                  view={p.view}
                  target={p.target}
                  targetKey={p.targetKey}
                  follow={p.follow}
                  flash={p.flash && p.flash.key === p.activeKey ? p.flash.n : 0}
                  onUserScroll={p.onUserScroll}
                />
              )}
            </div>
          </>
        ) : (
          <Welcome busy={p.busy} activity={p.activity} onShowChat={p.onShowChat} />
        )}
        {p.terminal.length > 0 && <TerminalPanel commands={p.terminal} cwd={p.cwd} project={p.project} />}
      </div>
    </div>
  )
})

export interface CodeStatusProps {
  code: Pick<CodeAppState, 'view' | 'target' | 'typingName' | 'changed' | 'reads' | 'readOnly' | 'follow' | 'onToggleFollow' | 'activePath'>
  /** Subagente: o papel ("executor"); principal: vazio. */
  who: string
  /** O modelo (ou a sequência) do turno e o esforço. */
  models: readonly string[]
  effort: string
  /** A Prévia do HTML à vista: "Prévia ao vivo" no lugar de Ln/Col. */
  page?: PageTab | null
}

/** A barra de status do Código, na cor do Agent, na janela inteira (embaixo do editor e do Chat). */
export function CodeStatus({ code, who, models, effort, page = null }: CodeStatusProps): JSX.Element {
  const view = code.view
  const path = page?.path ?? code.activePath
  // Ln/Col: o cursor do Agent ou a 1ª linha numerada a partir de onde a tela está (o alvo de seguir).
  const at = view && code.target >= 0 ? view.rows.slice(code.target).find((r) => r.num !== null) : undefined
  const position = view?.caret?.ln != null ? { ln: view.caret.ln, col: view.caret.col } : at?.num != null ? { ln: at.num, col: 1 } : null
  return (
    <StatusBar
      who={who}
      typingName={code.typingName}
      changed={code.changed}
      read={code.reads.length}
      models={models}
      effort={effort}
      readOnly={code.readOnly}
      follow={code.follow}
      onToggleFollow={code.onToggleFollow}
      position={position}
      stats={view ? { added: view.added, removed: view.removed } : null}
      lang={path ? langName(path) : null}
      live={!!page}
    />
  )
}
