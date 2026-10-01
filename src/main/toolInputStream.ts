// Código em escrita pelo agente PRINCIPAL, ao vivo, para o monitor do escritório.
//
// Com `includePartialMessages` o SDK repassa o `input_json_delta` de cada
// tool_use antes de a ferramenta rodar. O JSON chega aos pedaços (Write de 161
// linhas = 191 deltas em 11 s, pedaços de até ~39 B; ver
// scripts/probe-tool-input-stream.mjs) e só fica válido no fim do bloco — por
// isso o leitor aqui é TOLERANTE: `JSON.parse` só serviria quando já não há nada
// ao vivo para mostrar. Sem dependência nova: o recorte necessário (uma chave
// string de nível superior e o último item de um array) cabe num scanner curto.
//
// O resultado é o `ChatEvent` `tool-input-delta`, efêmero (ver src/shared/ipc.ts).
import type { ChatEvent } from '../shared/ipc'

export type ToolInputDelta = Extract<ChatEvent, { kind: 'tool-input-delta' }>
export type LiveToolName = ToolInputDelta['name']

/** Só as ferramentas que escrevem código; o resto não tem o que mostrar ao vivo. */
const LIVE_TOOLS: ReadonlySet<string> = new Set<LiveToolName>(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Intervalo mínimo entre emissões do MESMO bloco: no máximo 10 por segundo.
 *  Mais que isso só gastaria IPC e render — o olho não acompanha. */
export const EMIT_INTERVAL_MS = 100
/** Linhas do fim do texto que vão em cada evento: é o que cabe no monitor, e
 *  manda um tamanho fixo pelo IPC mesmo num Write de milhares de linhas. */
export const TAIL_LINES = 40

/** Forma mínima de um `stream_event` do SDK lida aqui e no agentSession. */
export interface RawStreamEvent {
  type: string
  index?: number
  message?: { id?: string }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string }
}

const ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/'
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * Decodifica a string JSON que começa em `start` (logo depois da aspa de
 * abertura) até a aspa de fechamento ou o fim do texto. Um escape cortado no fim
 * (`\`, `\u00`, ou a 1ª metade de um par substituto sem a 2ª) é deixado de fora:
 * o próximo pedaço o completa, e mostrar meio escape seria mostrar lixo.
 */
function decodeString(s: string, start: number): string {
  let out = ''
  let from = start
  let i = start
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') return out + s.slice(from, i)
    if (ch !== '\\') {
      i++
      continue
    }
    out += s.slice(from, i)
    const esc = s[i + 1]
    if (esc === undefined) return out
    if (esc === 'u') {
      const hex = s.slice(i + 2, i + 6)
      if (hex.length < 4) return out
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        const code = parseInt(hex, 16)
        // A 2ª metade (`\uXXXX`, 6 caracteres) ainda não chegou: segura a 1ª.
        if (isHighSurrogate(code) && s.length < i + 12) return out
        out += String.fromCharCode(code)
        i += 6
      } else {
        // JSON inválido (o modelo não gera isto): fica o `u` literal, sem travar.
        out += 'u'
        i += 2
      }
    } else {
      out += ESCAPES[esc] ?? esc
      i += 2
    }
    from = i
  }
  return out + s.slice(from)
}

/** Índice logo depois da aspa que fecha a string iniciada em `start`, ou -1 se
 *  ela ainda não fechou. Só pula — não decodifica (sem alocar à toa). */
function stringEnd(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '"') return i + 1
  }
  return -1
}

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++
  return i
}

/**
 * Onde começa o valor da chave `key` do objeto de NÍVEL SUPERIOR de `s`, ou
 * `undefined` se ela ainda não apareceu inteira (com os dois-pontos). A mesma
 * chave dentro de um objeto aninhado, ou como texto dentro de outra string, não
 * conta: profundidade e strings são acompanhadas o tempo todo.
 */
function valueStart(s: string, key: string): number | undefined {
  let i = skipWs(s, 0)
  if (s[i] !== '{') return undefined
  let depth = 0
  let expectKey = false
  for (; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"') {
      const end = stringEnd(s, i + 1)
      if (end < 0) return undefined
      if (depth === 1 && expectKey) {
        const colon = skipWs(s, end)
        if (s[colon] !== ':') return undefined
        if (decodeString(s, i + 1) === key) return skipWs(s, colon + 1)
        expectKey = false
        i = colon
      } else {
        i = end - 1
      }
    } else if (ch === '{' || ch === '[') {
      depth++
      if (depth === 1) expectKey = true
    } else if (ch === '}' || ch === ']') {
      depth--
      // O objeto fechou sem a chave: o que vier depois não é dele.
      if (depth === 0) return undefined
    } else if (ch === ',' && depth === 1) {
      expectKey = true
    }
  }
  return undefined
}

/**
 * O valor, possivelmente incompleto, da chave string `key` no nível superior do
 * JSON parcial. `undefined` enquanto a chave não apareceu ou o valor dela ainda
 * não começou como string.
 */
export function extractPartialString(partialJson: string, key: string): string | undefined {
  const at = valueStart(partialJson, key)
  if (at === undefined || partialJson[at] !== '"') return undefined
  return decodeString(partialJson, at + 1)
}

/** O texto (parcial) do ÚLTIMO objeto do array `key` de nível superior — é o
 *  item que está sendo escrito agora. Ele mesmo é um JSON parcial de objeto, então
 *  serve direto para `extractPartialString`. */
function lastArrayObject(s: string, key: string): string | undefined {
  const at = valueStart(s, key)
  if (at === undefined || s[at] !== '[') return undefined
  let depth = 0
  let last: number | undefined
  for (let i = at; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"') {
      const end = stringEnd(s, i + 1)
      if (end < 0) break
      i = end - 1
    } else if (ch === '{' || ch === '[') {
      if (depth === 1 && ch === '{') last = i
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) break
    }
  }
  return last === undefined ? undefined : s.slice(last)
}

export interface ToolInputFields {
  filePath?: string
  oldText?: string
  newText?: string
}

/** Os campos que o monitor mostra, por ferramenta, lidos do JSON parcial. */
export function toolInputFields(name: LiveToolName, json: string): ToolInputFields {
  switch (name) {
    case 'Write':
      return { filePath: extractPartialString(json, 'file_path'), newText: extractPartialString(json, 'content') }
    case 'Edit':
      return {
        filePath: extractPartialString(json, 'file_path'),
        oldText: extractPartialString(json, 'old_string'),
        newText: extractPartialString(json, 'new_string')
      }
    case 'MultiEdit': {
      const item = lastArrayObject(json, 'edits')
      return {
        filePath: extractPartialString(json, 'file_path'),
        oldText: item === undefined ? undefined : extractPartialString(item, 'old_string'),
        newText: item === undefined ? undefined : extractPartialString(item, 'new_string')
      }
    }
    case 'NotebookEdit':
      return { filePath: extractPartialString(json, 'notebook_path'), newText: extractPartialString(json, 'new_source') }
  }
}

/** As últimas `n` linhas de `text` e quantas linhas ele tem ao todo. */
export function tailLines(text: string, n = TAIL_LINES): { text: string; totalLines: number } {
  if (!text) return { text: '', totalLines: 0 }
  let total = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) total++
  if (total <= n) return { text, totalLines: total }
  let cut = text.length
  for (let k = 0; k < n; k++) cut = text.lastIndexOf('\n', cut - 1)
  return { text: text.slice(cut + 1), totalLines: total }
}

interface OpenBlock {
  toolUseId: string
  name: LiveToolName
  json: string
  lastEmitAt: number
}

/**
 * Acumula o JSON de cada bloco tool_use de ferramenta de edição e emite o
 * `tool-input-delta`, com throttle por bloco e uma emissão final (`done`).
 *
 * A chave do bloco é (mensagem corrente, `index`): o `index` recomeça a cada
 * mensagem e não é sempre 0, então `message_start` fecha o que tiver sobrado da
 * anterior. Uma instância por sessão, alimentada SÓ com eventos do agente
 * principal — o `index` de um subagente colidiria com o dele.
 *
 * O throttle é de borda de subida, sem timer: um delta que chega dentro do
 * intervalo só acumula, e o próximo depois do intervalo leva tudo. Uma pausa no
 * meio do bloco segura no máximo o último pedaço, e o `content_block_stop` sempre
 * manda o estado final.
 */
export class ToolInputStreams {
  private readonly blocks = new Map<number, OpenBlock>()

  constructor(
    private readonly emit: (event: ToolInputDelta) => void,
    private readonly now: () => number = Date.now
  ) {}

  handle(ev: RawStreamEvent): void {
    if (ev.type === 'message_start') {
      this.finishAll()
      return
    }
    if (typeof ev.index !== 'number') return
    if (ev.type === 'content_block_start') {
      const b = ev.content_block
      if (b?.type !== 'tool_use' || typeof b.id !== 'string' || !b.id || !LIVE_TOOLS.has(b.name ?? '')) return
      this.blocks.set(ev.index, { toolUseId: b.id, name: b.name as LiveToolName, json: '', lastEmitAt: -Infinity })
    } else if (ev.type === 'content_block_delta') {
      const block = this.blocks.get(ev.index)
      if (!block || ev.delta?.type !== 'input_json_delta' || typeof ev.delta.partial_json !== 'string') return
      block.json += ev.delta.partial_json
      if (this.now() - block.lastEmitAt >= EMIT_INTERVAL_MS) this.send(block, false)
    } else if (ev.type === 'content_block_stop') {
      const block = this.blocks.get(ev.index)
      if (!block) return
      this.blocks.delete(ev.index)
      this.send(block, true)
    }
  }

  /** Fecha com `done` todo bloco ainda aberto: stream interrompido (Stop, erro)
   *  ou fim de turno. Sem isto o monitor ficaria mostrando "escrevendo" para um
   *  bloco que nunca vai receber `content_block_stop`. */
  finishAll(): void {
    if (this.blocks.size === 0) return
    const open = [...this.blocks.values()]
    this.blocks.clear()
    for (const block of open) this.send(block, true)
  }

  private send(block: OpenBlock, done: boolean): void {
    block.lastEmitAt = this.now()
    const fields = toolInputFields(block.name, block.json)
    const next = tailLines(fields.newText ?? '')
    this.emit({
      kind: 'tool-input-delta',
      toolUseId: block.toolUseId,
      name: block.name,
      ...(fields.filePath !== undefined ? { filePath: fields.filePath } : {}),
      ...(fields.oldText !== undefined ? { oldText: tailLines(fields.oldText).text } : {}),
      newText: next.text,
      totalLines: next.totalLines,
      done
    })
  }
}
