/** Markdown do Preview: o mesmo Markdown do chat, numa coluna de leitura centrada. */
import { Markdown } from '../../components/Markdown'
import { PREVIEW_LIMITS } from '@shared/preview'
import { PreviewLinkBase } from '../PreviewLink'
import { dirOf } from '../previewTabs'
import { ViewerNotice } from './ViewerNotice'
import { fmtInt } from './tableData'
import './viewers.css'

const TEXT_MB = PREVIEW_LIMITS.textBytes / (1024 * 1024)

interface Props {
  text: string
  truncated?: boolean
  /** Caminho do .md: link relativo dentro dele vale a partir da pasta dele. */
  path?: string
}

export function MarkdownView({ text, truncated = false, path }: Props): JSX.Element {
  return (
    <div className="pv-md pv-scroll">
      <div className="pv-md-inner">
        {truncated && <ViewerNotice>Arquivo grande: mostrando só os primeiros {fmtInt(TEXT_MB)} MB.</ViewerNotice>}
        <PreviewLinkBase dir={path ? dirOf(path) : null}>
          <Markdown text={text} />
        </PreviewLinkBase>
      </div>
    </div>
  )
}
