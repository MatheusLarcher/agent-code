/**
 * Conversões do Preview que não dependem de React: o elemento apontado pelo
 * seletor vira um PickedElement (o mesmo chip que a extensão do Chrome manda
 * pelo onBrowserPicked) e cada falha de leitura de arquivo ganha uma frase clara.
 */
import type { PickedElement } from '@shared/ipc'
import type { InspectorPick, PreviewFileResult, PreviewTab } from '@shared/preview'

/** Pick do seletor → chip do composer, marcado com a aba do Preview de onde veio. */
export function pickToElement(pick: InspectorPick, tab: Pick<PreviewTab, 'id' | 'title'>): PickedElement {
  return {
    selector: pick.selector,
    tagName: pick.tagName,
    id: pick.id,
    classes: pick.classes,
    text: pick.text,
    html: pick.html,
    url: pick.url,
    tabId: tab.id,
    tabName: `Preview · ${tab.title}`
  }
}

type FailReason = Extract<PreviewFileResult, { ok: false }>['reason'] | 'no-api'

const REASON_TEXT: Record<FailReason, string> = {
  'not-found': 'Arquivo não encontrado. Ele pode ter sido movido ou apagado — confira o caminho no endereço.',
  blocked: 'Este arquivo fica numa pasta protegida (senhas, chaves ou configurações do sistema), então o Preview não abre.',
  'too-big': 'O arquivo é grande demais para mostrar aqui. Use "Abrir fora do app" para ver no programa padrão.',
  unsupported: 'O Preview ainda não sabe mostrar este tipo de arquivo. Use "Abrir fora do app" para ver no programa padrão.',
  error: 'Não deu para ler o arquivo.',
  'no-api': 'Esta versão do app ainda não lê arquivos no Preview. Use "Abrir fora do app".'
}

/** Título curto do erro (cabeçalho do aviso). */
const REASON_TITLE: Record<FailReason, string> = {
  'not-found': 'Arquivo não encontrado',
  blocked: 'Arquivo protegido',
  'too-big': 'Arquivo grande demais',
  unsupported: 'Tipo de arquivo sem visualização',
  error: 'Erro ao abrir o arquivo',
  'no-api': 'Preview de arquivo indisponível'
}

/** Título e frase para mostrar quando o arquivo não abre. */
export function failureText(reason: FailReason, detail?: string): { title: string; text: string } {
  const base = REASON_TEXT[reason] ?? REASON_TEXT.error
  // No erro genérico, o detalhe do main ajuda a entender (permissão, arquivo em uso…).
  const text = reason === 'error' && detail ? `${base} Detalhe: ${detail}` : base
  return { title: REASON_TITLE[reason] ?? REASON_TITLE.error, text }
}
