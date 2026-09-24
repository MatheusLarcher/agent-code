/**
 * Mídia da Tela de Planejamento: regras puras compartilhadas por main e
 * renderer (sem tocar disco). Os arquivos moram em <plano>/midia/<nome>, e o
 * nome é sempre o saneado por mediaFileName — é ele que os cards guardam em
 * `anexos` e que o IPC aceita.
 */
import {
  ARCHIVE_EXTS,
  AUDIO_EXTS,
  CODE_EXTS,
  EXCEL_EXTS,
  extOf,
  IMAGE_EXTS,
  PDF_EXTS,
  PPT_EXTS,
  TEXT_EXTS,
  VIDEO_EXTS,
  WORD_EXTS
} from './mime'

/** Subpasta do plano onde as mídias ficam. */
export const MEDIA_DIR = 'midia'
/** Teto de uma importação (planning:importMedia, plan_midia_importar). */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024
/** Teto do que planning:readMedia devolve em base64 (pré-visualização). */
export const MAX_MEDIA_PREVIEW_BYTES = 20 * 1024 * 1024
/** Quantos anexos um card pode ter. */
export const MAX_ANEXOS_POR_CARD = 20

export type MediaKind =
  | 'imagem'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'planilha'
  | 'documento'
  | 'apresentacao'
  | 'texto'
  | 'compactado'
  | 'outro'

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  imagem: 'Imagem',
  pdf: 'PDF',
  video: 'Vídeo',
  audio: 'Áudio',
  planilha: 'Planilha',
  documento: 'Documento',
  apresentacao: 'Apresentação',
  texto: 'Texto',
  compactado: 'Compactado',
  outro: 'Arquivo'
}

/** Uma mídia em <plano>/midia/, como o main a devolve. `path` é ABSOLUTO. */
export interface PlanMediaDto {
  name: string
  path: string
  kind: MediaKind
  size: number
  mediaType: string
}

const KIND_BY_GROUP: Array<[MediaKind, readonly string[]]> = [
  ['imagem', IMAGE_EXTS],
  ['pdf', PDF_EXTS],
  ['video', VIDEO_EXTS],
  ['audio', AUDIO_EXTS],
  ['planilha', EXCEL_EXTS],
  ['documento', WORD_EXTS],
  ['apresentacao', PPT_EXTS],
  ['texto', [...TEXT_EXTS, ...CODE_EXTS]],
  ['compactado', ARCHIVE_EXTS]
]

/** Tipo da mídia pela extensão do nome ou caminho (sem extensão conhecida: 'outro'). */
export function mediaKindOf(nameOrPath: string): MediaKind {
  const ext = extOf(String(nameOrPath ?? ''))
  if (!ext) return 'outro'
  for (const [kind, exts] of KIND_BY_GROUP) if (exts.includes(ext)) return kind
  return 'outro'
}

const MEDIA_NAME_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9]{1,10})?$/
const MAX_MEDIA_NAME = 120
/** Nomes de dispositivo do Windows: "con.png" não é um arquivo comum lá. */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/

/** Nome de mídia: [a-z0-9_-] com uma extensão opcional, até 120 caracteres —
 *  sem separador, sem '..', sem maiúscula, sem nome de dispositivo do Windows. */
export function isValidMediaName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > MAX_MEDIA_NAME || !MEDIA_NAME_RE.test(name)) return false
  return !WINDOWS_DEVICE_RE.test(name.split('.')[0])
}

/** Sem acento, minúsculo, tudo que não é [a-z0-9] vira '-' (sem '-' nas pontas). */
function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Nome saneado para gravar `original` em midia/: `<prefix>-<nome>.<ext>`, ex.:
 * mediaFileName('Tela de Login.PNG', 'a1b2c3') === 'a1b2c3-tela-de-login.png'.
 * Usa só o nome base (caminho some); extensão fora de [a-z0-9]{1,10} some;
 * nome vazio vira "arquivo". `prefix` ([a-z0-9], 1 a 16) evita colisão.
 */
export function mediaFileName(original: string, prefix: string): string {
  if (typeof prefix !== 'string' || !/^[a-z0-9]{1,16}$/.test(prefix)) {
    throw new Error('prefixo de mídia inválido: use [a-z0-9], de 1 a 16 caracteres')
  }
  const base = String(original ?? '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  let stem = dot > 0 ? base.slice(0, dot) : base
  let ext = dot > 0 ? slugify(base.slice(dot + 1)).replace(/-/g, '') : ''
  if (ext.length > 10) ext = ''
  const suffix = ext ? `.${ext}` : ''
  const room = MAX_MEDIA_NAME - prefix.length - 1 - suffix.length
  stem = slugify(stem).slice(0, room).replace(/-+$/, '') || 'arquivo'
  return `${prefix}-${stem}${suffix}`
}
