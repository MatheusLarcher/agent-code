/**
 * Nome legível de um elemento escolhido com Selecionar, para as etiquetas do
 * campo de mensagem e da bolha: "botão “Comprar”", "título “Layout”",
 * "forma do slide". Classe interna do app (pv-*, pp-*) e seletor nunca aparecem:
 * esses detalhes ficam na dica do hover.
 */
export interface NamedElement {
  tag: string
  id?: string
  classes?: string
  text?: string
}

const KIND: Record<string, string> = {
  a: 'link',
  button: 'botão',
  img: 'imagem',
  svg: 'ícone',
  video: 'vídeo',
  input: 'campo',
  textarea: 'campo',
  select: 'lista',
  label: 'rótulo',
  p: 'parágrafo',
  li: 'item',
  ul: 'lista',
  ol: 'lista',
  table: 'tabela',
  thead: 'tabela',
  tbody: 'tabela',
  tr: 'linha',
  td: 'célula',
  th: 'cabeçalho',
  code: 'código',
  pre: 'código',
  blockquote: 'citação',
  nav: 'menu',
  header: 'topo',
  footer: 'rodapé',
  form: 'formulário',
  section: 'seção',
  article: 'seção',
  span: 'texto',
  strong: 'texto',
  em: 'texto'
}

/** O que o elemento é, em português ("título", "botão", "forma do slide"…). */
export function elementKind(el: NamedElement): string {
  const tag = el.tag.toLowerCase()
  const cls = ` ${el.classes ?? ''} `
  if (/ pv-sl-shape /.test(cls)) return 'forma do slide'
  if (/ pv-sl-/.test(cls)) return 'slide'
  if (/ pv-(tbl|table)/.test(cls)) return 'tabela'
  if (/^h[1-6]$/.test(tag)) return 'título'
  return KIND[tag] ?? 'bloco'
}

/** "tipo “texto”" (texto cortado), ou "tipo #id", ou só o tipo. */
export function elementName(el: NamedElement, max = 30): string {
  const kind = elementKind(el)
  const text = (el.text ?? '').replace(/\s+/g, ' ').trim()
  if (text) {
    const room = Math.max(6, max - kind.length - 3)
    const cut = text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text
    return `${kind} “${cut}”`
  }
  return el.id ? `${kind} #${el.id}` : kind
}
