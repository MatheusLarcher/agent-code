import { useEffect, useRef, useState, type RefObject } from 'react'
import type { FileAttachment, ImageAttachment } from '@shared/ipc'
import { looksLikeFileUrl, looksLikeLocalPath } from '@shared/mime'
import type { EditorElement } from './InlineEditor'
import {
  makeFileAtt,
  makeImageAtt,
  makePendingAtt,
  makeRefAtt,
  releaseSrc,
  serializeInline,
  type InlineAtt,
  type OutgoingMessage
} from './inlineAttachments'
import {
  discardDraftCopies,
  fromDraft,
  promoteDraftCopies,
  replaceTokens,
  toDraft,
  type DraftRefMedia,
  type DraftRestore
} from './draftMedia'

/** Max size for a single non-image attachment read into memory (keeps the IPC payload sane). */
const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Same cap `readFileBytes` enforces in main — a bigger image becomes a plain chip. */
const MAX_IMAGE_PREVIEW_BYTES = 50 * 1024 * 1024
/** Resultados guardados de itens fora da tela (troca de conversa). */
const MAX_PARKED = 64

/** Read an image File as a base64 attachment (strips the data-URL prefix). */
function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(reader.result))
      if (m) resolve({ mediaType: m[1], data: m[2] })
      else reject(new Error('imagem inválida'))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Read any file as a base64 FileAttachment (keeps name/type/size for the chip). */
function fileToFileAttachment(file: File): Promise<FileAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const m = /^data:([^;]*);base64,(.*)$/.exec(String(reader.result))
      resolve({
        name: file.name || 'arquivo',
        mediaType: m?.[1] || file.type || 'application/octet-stream',
        data: m?.[2] || '',
        size: file.size
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

interface Options {
  editorRef: RefObject<EditorElement | null>
  /** Conversa dona do campo AGORA (o download de URL colada vai para a pasta dela). */
  convIdRef: RefObject<string | null>
  notify: (kind: 'erro', msg: string) => void
  /** Rascunho com que o campo abre (texto com `{{midia:N}}` + lista). */
  initialDraft: string
  initialMedia?: readonly unknown[]
}

type Parked = InlineAtt | { fallback: string; error: string }
export type DraftResult = { text: string; media: DraftRefMedia[] }
/** O campo de uma conversa no instante de um flush que ainda espera a cópia em disco. */
type Snapshot = { value: string; order: string[]; atts: Map<string, InlineAtt> }
type Copyable = Extract<InlineAtt, { kind: 'image' | 'file' }>

/**
 * Anexos do composer inline. Todo anexo entra NA HORA no ponto do cursor como
 * item "resolvendo" e vira miniatura/chip quando o conteúdo chega; o envio
 * espera (`resolving`). Falha: o item some (arquivo) ou volta a ser a linha
 * colada (caminho/URL), no mesmo lugar. Resolução que termina com a conversa
 * fora da tela fica guardada pelo id do item e é aplicada quando ela volta.
 */
export function useInlineAttachments({ editorRef, convIdRef, notify, initialDraft, initialMedia }: Options) {
  const registry = useRef(new Map<string, InlineAtt>())
  const parked = useRef(new Map<string, Parked>())
  const inflight = useRef(new Set<string>())
  const stashing = useRef(new Map<string, Promise<string | null>>())
  // Cópia em disco já feita, por item (sobrevive à troca de conversa: ver `snaps`).
  const storedById = useRef(new Map<string, string>())
  // Itens que saíram do campo (ou foram enviados): a cópia deles é só do rascunho e vai embora.
  const dropped = useRef(new Set<string>())
  // Flush que espera a cópia em disco, por conversa: voltar a ela antes de terminar
  // restaura o campo DAQUI (o rascunho gravado ainda é o de antes).
  const snaps = useRef(new Map<string, Snapshot>())
  const init = useRef<{ value: string; order: string[]; jobs: Array<() => void> } | null>(null)
  if (init.current === null) init.current = prepare(initialDraft, initialMedia)
  const [order, setOrderState] = useState<string[]>(init.current.order)
  const orderRef = useRef<string[]>(init.current.order)
  const [version, setVersion] = useState(0)

  // Itens "resolvendo" que estão no texto agora (item apagado, ou de outra conversa, não segura o envio).
  const resolving = order.reduce((n, id) => n + (registry.current.get(id)?.kind === 'pending' ? 1 : 0), 0)

  useEffect(() => {
    init.current?.jobs.forEach((job) => job())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setOrder(next: string[]): void {
    orderRef.current = next
    setOrderState(next)
  }

  function register(att: InlineAtt): InlineAtt {
    registry.current.set(att.id, att)
    return att
  }

  function reset(): void {
    registry.current.forEach(releaseSrc)
    registry.current.clear()
    setOrder([])
  }

  function upgrade(id: string, att: InlineAtt): void {
    const next = { ...att, id } as InlineAtt
    const old = registry.current.get(id)
    if (old) releaseSrc(old)
    registry.current.set(id, next)
    editorRef.current?.refreshToken(next)
    setVersion((v) => v + 1)
  }

  function giveUp(id: string, text: string): void {
    const old = registry.current.get(id)
    if (old) releaseSrc(old)
    registry.current.delete(id)
    editorRef.current?.replaceToken(id, text)
    setVersion((v) => v + 1)
  }

  function park(id: string, result: Parked): void {
    parked.current.set(id, result)
    if (parked.current.size > MAX_PARKED) parked.current.delete(parked.current.keys().next().value!)
  }

  // Arquivo real maior que 25 MB: vai por caminho no disco (sem bytes pelo IPC).
  async function readLarge(file: File): Promise<InlineAtt | string> {
    let path: string
    try {
      path = window.api.getPathForFile(file)
    } catch {
      path = ''
    }
    if (!path) return `Arquivo maior que 25 MB precisa ter um caminho no disco: ${file.name}`
    const resolved = await window.api.resolvePastedPath(path)
    if (!resolved.ok) return `Arquivo não encontrado: ${resolved.error}`
    if (resolved.isImage && resolved.size <= MAX_IMAGE_PREVIEW_BYTES) {
      const bytes = await window.api.readFileBytes(resolved.path)
      if (!bytes.ok) return `Falha ao ler imagem: ${bytes.error}`
      return makeImageAtt({ mediaType: resolved.mediaType, data: bytes.base64 }, resolved.name)
    }
    return makeRefAtt({ name: resolved.name, path: resolved.path, mediaType: resolved.mediaType, size: resolved.size })
  }

  async function readFile(file: File): Promise<InlineAtt | string> {
    if (file.size > MAX_FILE_BYTES) return readLarge(file)
    if (file.type.startsWith('image/')) return makeImageAtt(await fileToAttachment(file), file.name || 'imagem')
    return makeFileAtt(await fileToFileAttachment(file))
  }

  // Caminho local ou URL de arquivo colados: stat/download no main.
  async function readLine(line: string): Promise<InlineAtt | string> {
    const isUrl = looksLikeFileUrl(line)
    const resolved = isUrl
      ? await window.api.downloadPastedUrl(line, convIdRef.current ?? '')
      : await window.api.resolvePastedPath(line)
    if (!resolved.ok) return `${isUrl ? 'Falha ao baixar' : 'Arquivo não encontrado'}: ${resolved.error}`
    if (resolved.isImage) {
      const bytes = await window.api.readFileBytes(resolved.path)
      if (!bytes.ok) return `Falha ao ler imagem: ${bytes.error}`
      return makeImageAtt({ mediaType: resolved.mediaType, data: bytes.base64 }, resolved.name)
    }
    return makeRefAtt({ name: resolved.name, path: resolved.path, mediaType: resolved.mediaType, size: resolved.size })
  }

  // Imagem/arquivo de um rascunho: os bytes voltam da cópia em disco (que continua sendo a referência).
  async function readStored(r: Extract<DraftRestore, { kind: 'image' | 'file' }>): Promise<InlineAtt | string> {
    const bytes = await window.api.readFileBytes(r.path)
    if (!bytes.ok) return `Anexo do rascunho não encontrado (${r.name}): ${bytes.error}`
    const att =
      r.kind === 'image'
        ? makeImageAtt({ mediaType: r.mediaType, data: bytes.base64 }, r.name)
        : makeFileAtt({ name: r.name, mediaType: r.mediaType, data: bytes.base64, size: bytes.size })
    return { ...att, stored: r.path } as InlineAtt
  }

  // Caminho colado de um rascunho: só volta se o arquivo ainda existe.
  async function readRef(r: Extract<DraftRestore, { kind: 'ref' }>): Promise<InlineAtt | string> {
    const resolved = await window.api.resolvePastedPath(r.path)
    if (!resolved.ok) return `Anexo do rascunho não encontrado (${r.name}): ${resolved.error}`
    return makeRefAtt({ name: r.name, path: resolved.path, mediaType: r.mediaType, size: resolved.size })
  }

  /** Resolve um item já no campo; `fallback` é o texto que volta no lugar dele se falhar. */
  async function settle(id: string, work: () => Promise<InlineAtt | string>, fallback: string): Promise<void> {
    if (inflight.current.has(id)) return
    inflight.current.add(id)
    let result: InlineAtt | string
    try {
      result = await work()
    } catch (err) {
      result = `Falha ao anexar: ${err instanceof Error ? err.message : String(err)}`
    }
    inflight.current.delete(id)
    // O item não está no campo agora (a conversa dele saiu da tela): guarda.
    if (!registry.current.has(id)) {
      park(id, typeof result === 'string' ? { fallback, error: result } : result)
      return
    }
    if (typeof result === 'string') {
      notify('erro', result)
      giveUp(id, fallback)
    } else {
      upgrade(id, result)
    }
  }

  /** Rascunho -> campo: registra os anexos e diz o que ainda falta resolver. */
  function prepare(text: string, media: readonly unknown[] | undefined): { value: string; order: string[]; jobs: Array<() => void> } {
    const d = fromDraft(text, media)
    d.atts.forEach(register)
    const drop = new Map<string, string>()
    const jobs: Array<() => void> = []
    for (const r of d.restore) {
      const p = parked.current.get(r.id)
      if (p) {
        parked.current.delete(r.id)
        if ('fallback' in p) {
          drop.set(r.id, p.fallback)
          jobs.push(() => notify('erro', p.error))
        } else {
          registry.current.set(r.id, { ...p, id: r.id } as InlineAtt)
        }
      } else if (inflight.current.has(r.id)) {
        // ainda resolvendo: o resultado chega por `settle` e acha o item de volta
      } else if (r.kind === 'image' || r.kind === 'file') {
        jobs.push(() => void settle(r.id, () => readStored(r), ''))
      } else if (r.kind === 'ref') {
        jobs.push(() => void settle(r.id, () => readRef(r), ''))
      } else if (r.kind === 'pending' && r.line) {
        const line = r.line
        jobs.push(() => void settle(r.id, () => readLine(line), line))
      } else {
        drop.set(r.id, '') // arquivo que lia quando o app fechou: não há como refazer
      }
    }
    const out = drop.size ? replaceTokens(d.value, d.order, drop) : { value: d.value, order: d.order }
    return { ...out, jobs }
  }

  /** Botão de anexar, colar arquivo, arrastar: entra no cursor (ou em `at`). */
  async function addFiles(list: FileList | File[], at?: number | null): Promise<void> {
    const items = [...list].map((f) => ({ f, att: register(makePendingAtt(f.name || 'arquivo')) }))
    if (items.length === 0) return
    editorRef.current?.insertParts(
      items.map((x) => x.att),
      at
    )
    await Promise.all(items.map(({ f, att }) => settle(att.id, () => readFile(f), '')))
  }

  /**
   * Colar texto. Linhas que são caminho local ou URL de arquivo viram anexo NO
   * LUGAR delas; o resto entra como texto puro. Sem nenhuma, é só texto.
   */
  function pasteText(text: string): void {
    const editor = editorRef.current
    if (!editor) return
    const normalized = text.replace(/\r\n|\r/g, '\n')
    const lines = normalized.split('\n')
    const isRef = (l: string): boolean => !!l.trim() && (looksLikeLocalPath(l) || looksLikeFileUrl(l))
    if (!lines.some(isRef)) {
      editor.insertParts([normalized])
      return
    }
    const parts: Array<string | InlineAtt> = []
    const jobs: Array<{ id: string; line: string }> = []
    lines.forEach((line, i) => {
      if (i > 0) parts.push('\n')
      if (isRef(line)) {
        const att = register(makePendingAtt(line, line))
        jobs.push({ id: att.id, line })
        parts.push(att)
      } else if (line) {
        parts.push(line)
      }
    })
    editor.insertParts(parts)
    void Promise.all(jobs.map(({ id, line }) => settle(id, () => readLine(line), line)))
  }

  /** Campo de volta de um flush ainda gravando: os mesmos itens (e ids), com o que chegou enquanto isso. */
  function fromSnapshot(s: Snapshot): { value: string; order: string[]; jobs: Array<() => void> } {
    const drop = new Map<string, string>()
    const jobs: Array<() => void> = []
    for (const id of s.order) {
      const a = s.atts.get(id)
      if (!a) continue
      const stored = storedById.current.get(id)
      registry.current.set(id, (a.kind === 'image' || a.kind === 'file') && stored ? { ...a, stored } : a)
      if (a.kind !== 'pending') continue
      const p = parked.current.get(id)
      if (p) {
        parked.current.delete(id)
        if ('fallback' in p) {
          drop.set(id, p.fallback)
          jobs.push(() => notify('erro', p.error))
        } else registry.current.set(id, { ...p, id } as InlineAtt)
      }
    }
    const out = drop.size ? replaceTokens(s.value, s.order, drop) : { value: s.value, order: s.order }
    return { ...out, jobs }
  }

  /**
   * Troca o conteúdo pelo rascunho de uma conversa. Devolve o texto do campo.
   * Com um flush dela ainda esperando a cópia em disco, o rascunho gravado é o
   * de ANTES: o campo volta do instante do flush, e a imagem não some.
   */
  function load(convId: string, draftText: string, draftMedia: readonly unknown[] | undefined): string {
    registry.current.forEach(releaseSrc)
    registry.current.clear()
    const snap = snaps.current.get(convId)
    const p = snap ? fromSnapshot(snap) : prepare(draftText, draftMedia)
    setOrder(p.order)
    setVersion((v) => v + 1)
    p.jobs.forEach((job) => job())
    return p.value
  }

  // A cópia deste item era só do rascunho: sai do disco (e é refeita se o item voltar ao campo).
  function forget(id: string): void {
    dropped.current.add(id)
    const pending = stashing.current.get(id)
    stashing.current.delete(id)
    const stored = storedById.current.get(id)
    storedById.current.delete(id)
    const a = registry.current.get(id)
    const reread = a?.kind === 'pending' && a.from && (a.from.kind === 'image' || a.from.kind === 'file') ? a.from.path : undefined
    const copy = (a && (a.kind === 'image' || a.kind === 'file') && a.stored) || stored || reread
    if (a && (a.kind === 'image' || a.kind === 'file') && a.stored) registry.current.set(id, { ...a, stored: undefined })
    if (copy) discardDraftCopies([copy])
    else if (pending) void pending.then((path) => path && dropped.current.has(id) && discardDraftCopies([path]))
  }

  // Cópia em disco do anexo, uma vez por item (vários flushes esperam a mesma).
  function stash(att: Copyable, convId: string): Promise<string | null> {
    const had = stashing.current.get(att.id)
    if (had) return had
    const file = att.kind === 'image'
      ? { name: att.name, mediaType: att.image.mediaType, data: att.image.data }
      : { name: att.file.name, mediaType: att.file.mediaType, data: att.file.data }
    const api = window.api as Partial<typeof window.api>
    const p = (api.stashDraftAttachment ? api.stashDraftAttachment(convId, file) : Promise.resolve({ ok: false as const, error: '' }))
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        // Saiu do campo (ou foi enviado) enquanto copiava: a cópia já nasce órfã.
        if (dropped.current.has(att.id)) {
          discardDraftCopies([r.path])
          return null
        }
        storedById.current.set(att.id, r.path)
        const cur = registry.current.get(att.id)
        if (cur && (cur.kind === 'image' || cur.kind === 'file')) registry.current.set(att.id, { ...cur, stored: r.path })
        return r.path
      })
      .catch(() => {
        stashing.current.delete(att.id)
        return null
      })
    stashing.current.set(att.id, p)
    return p
  }

  const serialize = (value: string): OutgoingMessage => serializeInline(value, orderRef.current, registry.current)

  /**
   * Depois de `serialize` e do envio, antes de `reset`: a cópia do arquivo que
   * saiu na mensagem é MOVIDA de `rascunho/` para a pasta do envio (o caminho
   * que a mensagem leva); as outras cópias (imagem, que vai em bytes; item fora
   * do texto) vão embora.
   */
  function commitSend(): void {
    const inText = new Set(orderRef.current)
    const sent: string[] = []
    for (const [id, a] of registry.current) {
      if (a.kind === 'file' && a.stored && inText.has(id)) {
        sent.push(a.stored)
        storedById.current.delete(id)
        stashing.current.delete(id)
      } else forget(id)
    }
    promoteDraftCopies(sent)
  }

  /**
   * Rascunho do campo. Os anexos são lidos AGORA (a troca de conversa limpa o
   * registro logo depois); imagem/arquivo sem cópia em disco é copiado antes,
   * e aí a resposta vem por Promise. Sem nada a copiar, vem na hora. Item que
   * saiu do campo tem a cópia dele apagada.
   */
  function draftOf(value: string, convId: string, ord: readonly string[] = orderRef.current): DraftResult | Promise<DraftResult> {
    const inText = new Set(ord)
    for (const id of inText) dropped.current.delete(id)
    for (const id of [...registry.current.keys()]) if (!inText.has(id)) forget(id)
    snaps.current.delete(convId)
    const snap = new Map<string, InlineAtt>()
    for (const id of ord) {
      const a = registry.current.get(id)
      if (a) snap.set(id, a)
    }
    const need = [...snap.values()].filter((a): a is Copyable => (a.kind === 'image' || a.kind === 'file') && !a.stored)
    if (need.length === 0) return toDraft(value, ord, snap)
    const pending: Snapshot = { value, order: [...ord], atts: new Map(snap) }
    snaps.current.set(convId, pending)
    return Promise.all(
      need.map((a) =>
        stash(a, convId).then((path) => {
          if (path) snap.set(a.id, { ...a, stored: path })
        })
      )
    ).then(() => {
      if (snaps.current.get(convId) === pending) snaps.current.delete(convId)
      const d = toDraft(value, ord, snap)
      if (d.missing.length) {
        notify('erro', `Não consegui guardar no rascunho: ${d.missing.join(', ')}. Continua no campo, mas não volta se o app fechar.`)
      }
      return { text: d.text, media: d.media }
    })
  }

  return {
    initialValue: init.current.value,
    atts: registry.current,
    order,
    orderRef,
    setOrder,
    resolving,
    version,
    addFiles,
    pasteText,
    load,
    reset,
    serialize,
    commitSend,
    draftOf
  }
}
