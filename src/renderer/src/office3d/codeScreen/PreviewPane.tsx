/**
 * A Prévia do HTML à vista no editor (a aba "Prévia: x.html"): a barra — globo,
 * o endereço, "ao vivo" e recarregar — e a página no MockupFrame, o mesmo
 * iframe isolado do foco da TV. Montada só com a aba ativa e a tela aberta:
 * sair da aba (ou do app Código) desmonta o iframe; voltar recarrega.
 *
 * Ao vivo: cada escrita nova do arquivo (`writeId`) recarrega a página, no
 * máximo 1 vez a cada RELOAD_MS — a escrita que chega no meio da janela espera
 * o fim dela, e a última ganha. Perder a rolagem na recarga é aceito (como num
 * live reload).
 */
import { useEffect, useRef, useState } from 'react'
import { MockupFrame, type MockupUrlFn } from '../MockupFrame'
import { Icon } from './icons'
import { relativePath, slashed } from './pathGuard'
import './preview.css'

/** A janela da recarga automática. */
export const RELOAD_MS = 2_000

/** O valor, trocando no máximo 1 vez a cada `ms`: o que chega no meio da janela vale no fim dela (o último ganha). */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  // A montagem conta como troca: a página acabou de abrir.
  const at = useRef(Date.now())
  const latest = useRef(value)
  latest.current = value
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current || Object.is(value, shown)) return
    const apply = (): void => {
      timer.current = null
      at.current = Date.now()
      setShown(latest.current)
    }
    const wait = at.current + ms - Date.now()
    if (wait <= 0) apply()
    else timer.current = setTimeout(apply, wait)
  }, [value, shown, ms])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    },
    []
  )
  return shown
}

export interface PreviewPaneProps {
  cwd: string
  project: string
  /** Caminho absoluto do .html. */
  path: string
  name: string
  /** A última escrita do arquivo que deu certo (muda a cada Write/Edit): recarrega a página. */
  writeId: string | null
  /** O endereço no protocolo (window.api; injetável nos testes). */
  mockupUrl?: MockupUrlFn
}

export function PreviewPane({ cwd, project, path, name, writeId, mockupUrl }: PreviewPaneProps): JSX.Element {
  // A escrita que sai da janela lida do fim da conversa (scanHtmlWrites) vira null: não é escrita nova, a página fica.
  const last = useRef(writeId)
  if (writeId !== null) last.current = writeId
  const write = useThrottled(last.current, RELOAD_MS)
  const [manual, setManual] = useState(0)
  const rel = (cwd && relativePath(path, cwd)) || slashed(path)
  return (
    <div className="cm-pv" data-testid="monitor-preview">
      <div className="cm-pv-bar">
        <Icon name="globe" />
        <span className="cm-pv-url" title={slashed(path)}>
          agent-mockup://{project || 'projeto'}/{rel}
        </span>
        <span className="cm-pv-live" title="Recarrega sozinha quando o Agent edita o arquivo">
          ao vivo
        </span>
        <button type="button" className="cm-pv-reload" aria-label="Recarregar a prévia" title="Recarregar" onClick={() => setManual((n) => n + 1)}>
          <Icon name="reload" />
        </button>
      </div>
      <div className="cm-pv-page">
        <MockupFrame cwd={cwd} path={path} rel={name} mockupUrl={mockupUrl} reloadKey={`${write ?? '-'}:${manual}`} frameClass="cm-pv-frame" emptyClass="cm-pv-empty" testId="monitor-preview-iframe" />
      </div>
    </div>
  )
}
