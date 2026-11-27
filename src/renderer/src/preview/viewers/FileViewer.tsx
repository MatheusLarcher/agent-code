/**
 * Escolhe o visualizador pelo tipo do arquivo lido no main. Só o conteúdo, sem
 * cabeçalho (o nome do arquivo fica na barra de quem hospeda). html e mídia
 * abrem no <webview> do host: aqui devolvem null.
 */
import { codeLangFor, extOf, type PreviewFileOk } from '@shared/preview'
import { CodeView } from './CodeView'
import { JsonView } from './JsonView'
import { MarkdownView } from './MarkdownView'
import { SlidesView } from './SlidesView'
import { TableView } from './TableView'
import './viewers.css'

function body(result: PreviewFileOk): JSX.Element | null {
  switch (result.kind) {
    case 'markdown':
      return <MarkdownView text={result.text} truncated={result.truncated} path={result.path} />
    case 'table':
      return <TableView sheets={result.sheets} />
    case 'json':
      return <JsonView text={result.text} jsonl={extOf(result.path) === 'jsonl'} truncated={result.truncated} />
    case 'code':
      return <CodeView text={result.text} lang={result.lang ?? codeLangFor(result.path)} truncated={result.truncated} />
    case 'text':
      return <CodeView text={result.text} truncated={result.truncated} plain />
    case 'slides':
      return <SlidesView result={result} />
    default:
      return null
  }
}

export function FileViewer({ result }: { result: PreviewFileOk }): JSX.Element | null {
  const content = body(result)
  if (!content) return null
  return (
    <div className="pv-viewer" data-kind={result.kind}>
      {content}
    </div>
  )
}
