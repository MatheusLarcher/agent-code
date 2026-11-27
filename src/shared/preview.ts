/**
 * Preview dentro do app (aba "Preview" do painel da direita): contrato comum
 * entre o main (leitura/conversão de arquivo, protocolo, preload do seletor),
 * o preload (window.api.previewReadFile) e o renderer (abas, visualizadores,
 * <webview> com o seletor de elementos portado do Nexos).
 *
 * - Web e arquivos que o Chromium mostra sozinho (html, svg, imagem, pdf,
 *   vídeo, áudio) abrem num <webview>: URL http(s) direto, arquivo local pelo
 *   protocolo `agent-preview://` (com a mesma barreira de caminho sensível).
 * - Markdown, planilha, csv, json, código e texto: o main lê/converte e o
 *   renderer desenha (Markdown do chat, tabela com ordenar/filtrar/paginar).
 * - PowerPoint (.pptx): o main desmonta o zip em slides (caixas de texto,
 *   imagens, tabelas, linhas) com posição relativa; o renderer desenha em escala.
 */

/** Protocolo que serve arquivo local ao <webview> do preview. */
export const PREVIEW_PROTOCOL = 'agent-preview'

/** Partição (sessão) própria do <webview>: cookies/cache longe do app. */
export const PREVIEW_PARTITION = 'persist:agent-preview'

/** Como o preview mostra uma coisa. */
export type PreviewKind =
  | 'web' // URL http(s)
  | 'html' // .html/.htm/.svg local → <webview> via agent-preview://
  | 'media' // imagem, pdf, vídeo, áudio local → <webview> via agent-preview://
  | 'markdown'
  | 'table' // xlsx/xlsm/xls/ods/csv/tsv
  | 'json'
  | 'code'
  | 'text'
  | 'slides' // pptx
  | 'unsupported'

const EXT_KIND: Record<string, PreviewKind> = {
  html: 'html', htm: 'html', svg: 'html',
  png: 'media', jpg: 'media', jpeg: 'media', gif: 'media', webp: 'media', bmp: 'media', ico: 'media', avif: 'media',
  pdf: 'media', mp4: 'media', webm: 'media', mov: 'media', mp3: 'media', wav: 'media', ogg: 'media', m4a: 'media',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  xlsx: 'table', xlsm: 'table', xls: 'table', ods: 'table', csv: 'table', tsv: 'table',
  json: 'json', jsonl: 'json',
  pptx: 'slides',
  txt: 'text', log: 'text', env: 'text',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code', cs: 'code', java: 'code',
  go: 'code', rs: 'code', rb: 'code', php: 'code', sql: 'code', sh: 'code', ps1: 'code', bat: 'code', css: 'code',
  scss: 'code', yml: 'code', yaml: 'code', toml: 'code', xml: 'code', ini: 'code', c: 'code', h: 'code', cpp: 'code',
  kt: 'code', swift: 'code', dart: 'code', vue: 'code', svelte: 'code', dockerfile: 'code'
}

/** Extensão (minúscula, sem ponto) do caminho ou URL; '' se não houver. */
export function extOf(pathOrUrl: string): string {
  const clean = pathOrUrl.split(/[?#]/)[0]
  const base = clean.split(/[\\/]/).pop() ?? ''
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** URL http(s)? */
export function isWebUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
}

/** O que o preview faz com este caminho local ou URL. */
export function previewKindFor(pathOrUrl: string): PreviewKind {
  if (isWebUrl(pathOrUrl)) return 'web'
  return EXT_KIND[extOf(pathOrUrl)] ?? 'unsupported'
}

/** Linguagem do highlight.js para os arquivos de código (undefined = automático). */
export function codeLangFor(path: string): string | undefined {
  const ext = extOf(path)
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', cs: 'csharp', ps1: 'powershell', sh: 'bash', bat: 'dos', yml: 'yaml', rs: 'rust', rb: 'ruby',
    kt: 'kotlin', cpp: 'cpp', h: 'c', vue: 'xml', svelte: 'xml'
  }
  return map[ext] ?? (ext || undefined)
}

/** URL `agent-preview://file/<caminho codificado>` de um arquivo local. */
export function previewFileUrl(absPath: string): string {
  return `${PREVIEW_PROTOCOL}://file/${encodeURIComponent(absPath)}`
}

/** Inverso de previewFileUrl; null se não for uma URL do preview. */
export function pathFromPreviewUrl(url: string): string | null {
  const prefix = `${PREVIEW_PROTOCOL}://file/`
  if (!url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0])
  } catch {
    return null
  }
}

/** Limites da leitura feita pelo main. */
export const PREVIEW_LIMITS = {
  /** Texto (markdown, código, json, txt) lido inteiro até aqui; acima, corta e marca truncated. */
  textBytes: 2 * 1024 * 1024,
  /** Planilha: arquivo maior que isto nem é aberto. */
  tableFileBytes: 30 * 1024 * 1024,
  /** Linhas por aba da planilha mandadas ao renderer (o resto marca truncated). */
  tableRows: 5000,
  /** Colunas por aba. */
  tableCols: 200,
  /** PowerPoint: arquivo maior que isto nem é aberto. */
  pptxFileBytes: 60 * 1024 * 1024,
  /** Slides mandados ao renderer (o resto marca truncated). */
  pptxSlides: 300,
  /** Soma dos bytes das imagens embutidas; acima, a imagem vira um marcador. */
  pptxImageBytes: 40 * 1024 * 1024
} as const

export interface PreviewSheet {
  name: string
  /** Linha 0 = cabeçalho (como está no arquivo). Células já em texto (datas formatadas). */
  rows: string[][]
  /** A aba tinha mais linhas/colunas que o limite. */
  truncated: boolean
}

/** Trecho de texto com a mesma formatação. Tamanho em pontos; cor em #rrggbb. */
export interface PreviewRun {
  text: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  font?: string
  /** Espaço extra entre letras, em pt (negativo aperta). Vem de `spc` do a:rPr. */
  spacing?: number
}

export interface PreviewParagraph {
  runs: PreviewRun[]
  align?: 'left' | 'center' | 'right' | 'justify'
  /** Marcador do item ("•", "–", "1.") quando o parágrafo é lista. */
  bullet?: string
  /** Nível de recuo (0 = sem recuo). */
  level?: number
  /** Tamanho (pt) para dar altura ao parágrafo vazio. */
  size?: number
  /** Entrelinha em fração do espaçamento simples (1 = 100% do PowerPoint, 0.85 = 85%). */
  lineH?: number
  /** Entrelinha exata em pt (a:spcPts); vale no lugar de lineH. */
  linePt?: number
  /** Espaço antes/depois do parágrafo, em pt. */
  before?: number
  after?: number
}

export interface PreviewTextBody {
  paragraphs: PreviewParagraph[]
  anchor: 'top' | 'middle' | 'bottom'
  /** Margens internas [cima, direita, baixo, esquerda] em fração da LARGURA do slide. */
  pad: [number, number, number, number]
  /** wrap="none" do a:bodyPr: a linha não quebra para caber na caixa. */
  noWrap?: boolean
  /** a:normAutofit: o PowerPoint encolhe a fonte até o texto caber na altura da caixa (o renderer mede e reduz). */
  autofit?: boolean
}

/**
 * Posição em fração do slide (x/w da largura, y/h da altura), de 0 a 1.
 * Rotação em graus. Espessura de linha (lineW) em fração da largura do slide.
 */
interface PreviewBox {
  x: number
  y: number
  w: number
  h: number
  rot?: number
}

export type PreviewShape =
  | (PreviewBox & {
      type: 'box'
      fill?: string
      line?: string
      lineW?: number
      geom?: 'rect' | 'round' | 'ellipse'
      text?: PreviewTextBody
    })
  /** `image` é a chave em `images` do resultado (a mesma imagem não viaja duas vezes). */
  | (PreviewBox & { type: 'image'; image: string; flipH?: boolean; flipV?: boolean })
  | (PreviewBox & { type: 'line'; line: string; lineW: number; flipH?: boolean; flipV?: boolean })
  /** Tabela: só o texto das células; `size` (pt) e `color` da primeira célula com formato. */
  | (PreviewBox & { type: 'table'; rows: string[][]; size?: number; color?: string })
  /** O que o preview não desenha (gráfico, imagem .emf…): um marcador com o nome. */
  | (PreviewBox & { type: 'missing'; label: string })

export interface PreviewSlide {
  shapes: PreviewShape[]
  /** Cor de fundo (#rrggbb) ou chave de imagem em `images` (backgroundImage). */
  background?: string
  backgroundImage?: string
  /** Texto das anotações do apresentador. */
  notes?: string
  /** Slide marcado como oculto no arquivo. */
  hidden?: boolean
}

/** Resposta de window.api.previewReadFile(path). */
export type PreviewFileResult =
  | { ok: true; kind: 'markdown' | 'json' | 'code' | 'text'; path: string; text: string; truncated: boolean; lang?: string }
  | { ok: true; kind: 'table'; path: string; sheets: PreviewSheet[] }
  | { ok: true; kind: 'html' | 'media'; path: string; url: string }
  | {
      ok: true
      kind: 'slides'
      path: string
      /** Tamanho do slide em EMU (só a proporção e a escala das fontes importam). */
      width: number
      height: number
      slides: PreviewSlide[]
      /** Chave → data URL (image/png;base64…). */
      images: Record<string, string>
      /** Havia mais slides que o limite. */
      truncated: boolean
    }
  | { ok: false; path: string; reason: 'not-found' | 'blocked' | 'too-big' | 'unsupported' | 'error'; message: string }

/** Resultado de leitura com sucesso (o que os visualizadores recebem). */
export type PreviewFileOk = Extract<PreviewFileResult, { ok: true }>

/** Uma aba aberta dentro do Preview. */
export interface PreviewTab {
  id: string
  kind: PreviewKind
  /** URL http(s) ou caminho absoluto do arquivo local. */
  target: string
  title: string
}

/**
 * Seletor de elementos dentro do <webview> (portado do inspector do Nexos).
 * Host → guest: webview.send(canal). Guest → host: ipcRenderer.sendToHost(canal, dados).
 */
export const PREVIEW_INSPECTOR = {
  /** host→guest: liga/desliga o modo seleção (arg: boolean). */
  toggle: 'agent-preview-inspector:toggle',
  /** host→guest: apaga as marcas numeradas. */
  clear: 'agent-preview-inspector:clear',
  /**
   * host→guest: os seletores (em ordem) dos elementos desta aba que AINDA estão
   * no campo de mensagem. A página tira a marca dos outros e renumera estes
   * (marca N = "[elemento N]" do campo, contando só os desta aba).
   */
  sync: 'agent-preview-inspector:sync',
  /** guest→host: preload carregado na página (o host reenvia o toggle após navegar). */
  ready: 'agent-preview-inspector:ready',
  /** guest→host: elemento clicado (arg: InspectorPick). */
  picked: 'agent-preview-inspector:picked',
  /** guest→host: usuário apertou Esc (o host desliga o modo). */
  esc: 'agent-preview-inspector:esc',
  /**
   * guest→host: arquivo do Explorer sendo arrastado por cima da página. O
   * documento do app não recebe esse arraste (o webview engole), então o host
   * mostra a camada "Solte para abrir no Preview" por cima do painel.
   */
  dragfile: 'agent-preview-inspector:dragfile'
} as const

/** O que o seletor captura no clique (vira um PickedElement no composer). */
export interface InspectorPick {
  tagName: string
  selector: string
  id: string
  classes: string
  /** textContent normalizado, até 150 caracteres. */
  text: string
  /** outerHTML, até 300 caracteres. */
  html: string
  url: string
  /** Número da marca laranja na página (1, 2, 3…). */
  index: number
}
