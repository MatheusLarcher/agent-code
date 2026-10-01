/**
 * A tela do monitor: painel HTML com o que o personagem está fazendo agora.
 *
 * - Principal: assina o liveInput (só enquanto esta tela existe — fechada,
 *   nenhuma assinatura, e os deltas são descartados lá) e mostra as últimas
 *   linhas sendo escritas e o diff atual.
 * - Subagentes (e o principal sem delta): efeito de digitação que revela o
 *   conteúdo real em 1 a 2 s, com relógio injetável.
 *
 * Posição e animação de crescer ficam no contêiner (OfficePanel/OfficeView);
 * aqui só o conteúdo.
 */
import { useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import { extToLang } from '../CodeBlock'
import type { LookupInfo } from '../../office/adapter/director'
import type { OfficeFeed } from '../../office/adapter/feed'
import { liveInput, type ToolInputDelta } from '../../office/liveInput'
import { currentTool, screenModel, tail, typedBody, type ScreenModel } from './screenContent'
import { revealFraction, revealText, typingDuration } from './typing'

export interface CodeScreenProps {
  feed: OfficeFeed | null
  info: LookupInfo | undefined
  onOpenFile: (path: string) => void
  /** Só testes: relógio e passo do efeito de digitação. */
  now?: () => number
  tickMs?: number
}

function highlighted(code: string, lang: string): string | null {
  if (!code || !lang) return null
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

function Code({ text, lang, className }: { text: string; lang: string; className?: string }): JSX.Element {
  const html = useMemo(() => highlighted(text, lang), [text, lang])
  const cls = `office-screen-code hljs ${className ?? ''}`
  return html !== null ? <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} /> : <pre className={cls}>{text}</pre>
}

function PathLink({ path, onOpenFile }: { path: string; onOpenFile: (p: string) => void }): JSX.Element | null {
  if (!path) return null
  const name = path.split(/[\\/]/).pop() || path
  return (
    <button type="button" className="office-screen-path" title={path} onClick={() => onOpenFile(path)}>
      {name}
    </button>
  )
}

/** Corta cada texto do modelo na fração revelada (efeito de digitação). */
function revealModel(m: ScreenModel, f: number): ScreenModel {
  if (f >= 1) return m
  switch (m.kind) {
    case 'diff':
      return { ...m, hunks: m.hunks.map((h) => ({ old: h.old, new: revealText(h.new, f) })) }
    case 'write':
    case 'read':
    case 'other':
      return { ...m, text: revealText(m.text, f) }
    case 'bash':
      return { ...m, output: revealText(m.output, f) }
    case 'grep':
      return { ...m, lines: m.lines.slice(0, Math.ceil(m.lines.length * f)) }
    default:
      return m
  }
}

function Body({ model, onOpenFile }: { model: ScreenModel; onOpenFile: (p: string) => void }): JSX.Element {
  switch (model.kind) {
    case 'empty':
      return <div className="office-screen-empty">Sem ferramenta em uso.</div>
    case 'diff': {
      const lang = extToLang(model.path)
      return (
        <>
          <PathLink path={model.path} onOpenFile={onOpenFile} />
          {model.hunks.map((h, i) => (
            <div key={i} className="office-screen-hunk">
              {h.old && <Code text={h.old} lang={lang} className="office-screen-old" />}
              <Code text={h.new} lang={lang} className="office-screen-new" />
            </div>
          ))}
        </>
      )
    }
    case 'write':
    case 'read':
      return (
        <>
          <PathLink path={model.path} onOpenFile={onOpenFile} />
          <Code text={model.text} lang={extToLang(model.path)} />
        </>
      )
    case 'bash':
      return (
        <div className="office-screen-term">
          <div className="office-screen-cmd">$ {model.command}</div>
          {model.output && <pre className="office-screen-code">{model.output}</pre>}
        </div>
      )
    case 'grep':
      return (
        <>
          <div className="office-screen-cmd">
            {model.tool} <code>{model.pattern}</code>
          </div>
          <ul className="office-screen-list">
            {model.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      )
    default:
      return <pre className="office-screen-code">{model.text}</pre>
  }
}

/** Modelo do código ao vivo (principal): caminho, trecho antigo e as últimas linhas novas. */
function liveModel(ev: ToolInputDelta): ScreenModel {
  const path = ev.filePath ?? ''
  if (ev.oldText !== undefined) return { kind: 'diff', tool: ev.name, path, hunks: [{ old: ev.oldText, new: tail(ev.newText) }] }
  return { kind: 'write', tool: ev.name, path, text: tail(ev.newText) }
}

export function CodeScreen({ feed, info, onOpenFile, now = () => Date.now(), tickMs = 50 }: CodeScreenProps): JSX.Element {
  const convId = info?.convId ?? null
  const isMain = !!info && !info.trackId
  const [live, setLive] = useState<ToolInputDelta | undefined>(() =>
    isMain && convId ? liveInput.latest(convId, null) : undefined
  )

  // Ao vivo só no principal, e só enquanto a tela existir.
  useEffect(() => {
    if (!isMain || !convId) return
    setLive(liveInput.latest(convId, null))
    return liveInput.subscribe(convId, null, (ev) => setLive(ev.done ? undefined : ev))
  }, [isMain, convId])

  const tool = currentTool(feed, info)
  const model = useMemo(() => screenModel(tool), [tool?.id, tool?.result, tool?.open, tool && JSON.stringify(tool.input)])

  // Digitação: recomeça quando a ferramenta muda.
  const [typing, setTyping] = useState({ key: '', startedAt: 0, frac: 1 })
  const key = tool ? `${tool.id}|${tool.result !== undefined}` : ''
  const duration = typingDuration(typedBody(model).length)
  useEffect(() => {
    if (!key) return
    const startedAt = now()
    setTyping({ key, startedAt, frac: 0 })
    const id = setInterval(() => {
      const frac = revealFraction(startedAt, now(), duration)
      setTyping((t) => (t.key === key ? { ...t, frac } : t))
      if (frac >= 1) clearInterval(id)
    }, tickMs)
    return () => clearInterval(id)
    // now/tickMs são fixos por montagem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, duration])

  const shown = live ? liveModel(live) : revealModel(model, typing.key === key ? typing.frac : 0)
  const title = live ? `${live.name} · ao vivo` : model.kind === 'empty' ? 'Tela' : model.tool

  return (
    <div className="office-screen" data-testid="office-screen" data-kind={shown.kind}>
      <div className="office-screen-bar">
        <span className="office-screen-title">{title}</span>
        {live && <span className="office-screen-live" aria-label="ao vivo" />}
      </div>
      <div className="office-screen-body">
        <Body model={shown} onOpenFile={onOpenFile} />
      </div>
    </div>
  )
}
