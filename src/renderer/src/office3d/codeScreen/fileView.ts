/**
 * As linhas do editor de uma aba — PURO (sem React). É o "como no GitHub": o
 * que o Agent mudou em verde (+) e vermelho (−), nada inventado.
 *
 *   depois  o arquivo de agora: o texto do disco (com as edições que ainda não
 *           estavam nele quando foi lido) ou, sem disco, refeito do histórico
 *           (a base do turno + as edições; um Write diz o arquivo inteiro).
 *   antes   o arquivo antes do turno. Com o disco, o que ele prova: as edições
 *           desfeitas de trás para frente (o new_string achado UMA vez volta a
 *           ser o old_string; sem posição comprovada — sumiu, repete, replace_all
 *           de várias ocorrências, só apagou — a edição vira trecho solto) ou a
 *           base do histórico, se ela + as edições dão exatamente o disco. Sem
 *           disco, a base que o histórico conhece.
 *
 *   'full'   antes e depois conhecidos: o arquivo inteiro com os números reais
 *            e o diff por linha (LCS).
 *   'plain'  só o depois: o arquivo sem cores (a versão anterior é desconhecida).
 *   'hunks'  nenhum dos dois: só os trechos da própria ferramenta (old → new),
 *            sem número de linha.
 *
 * Ao vivo (`live`, o bloco costurado do liveInput): o Write mostra o arquivo que
 * está sendo digitado (verde = linha que o arquivo não tinha; arquivo novo, tudo
 * verde); o Edit troca o trecho antigo pelo que já foi digitado na posição dele
 * no arquivo (quando o trecho é achado uma vez só) e o diff sai como o final
 * sairá. Linha que o stream ainda não mostrou é 'gap' (placeholder apagado).
 */
import { applyEdit, type TabEdit } from './codeModel'
import { diffLines } from './lineDiff'
import { settledOld, type LiveBlock } from './stitch'

/** Linhas do fim que cada tool-input-delta traz (TAIL_LINES do main). */
export const LIVE_TAIL = 40

export type RowKind = 'ctx' | 'add' | 'del' | 'gap' | 'hunk'

/**
 * Uma linha do editor. `src` diz de onde vem o texto: 0 = antes, 1 = depois,
 * 2 = `blocks[block]` (trecho solto).
 */
export interface Row {
  kind: RowKind
  /** Número da linha no arquivo de agora; null = sem número (removida ou trecho solto). */
  num: number | null
  src: 0 | 1 | 2
  line: number
  block?: number
  /** Só no 'hunk': o rótulo do trecho. */
  label?: string
}

export type DiskReason = 'sensitive' | 'outside' | 'relative' | 'error' | 'loading' | 'unavailable' | 'large'

/** O arquivo no disco, como a tela o conhece. `reflected`: ferramentas já concluídas quando foi lido. */
export type DiskState =
  | { kind: 'text'; text: string; reflected: ReadonlySet<string> }
  | { kind: 'missing' }
  | { kind: 'none'; reason: DiskReason }

export interface ViewInput {
  edits: readonly TabEdit[]
  base: string | null
  disk: DiskState
  live?: LiveBlock | null
}

export interface FileView {
  mode: 'full' | 'plain' | 'hunks'
  rows: Row[]
  before: string
  after: string
  blocks: string[]
  added: number
  removed: number
  /** Primeira linha mudada (índice em rows); -1 sem mudança. */
  first: number
  /** Onde está a edição mais recente que ainda se acha no arquivo de agora (índice em rows); -1 = sem posição. */
  latest: number
  /** O cursor do Agent digitando: a linha (índice em rows), Ln (null sem número) e Col. */
  caret: { row: number; ln: number | null; col: number } | null
  /** Aviso honesto do que a tela não tem como mostrar. */
  note: string | null
}

/** As linhas do texto; a quebra final termina a última linha (não abre uma vazia), como no diff do GitHub. */
const lines = (text: string): string[] => (text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'))

/** O texto do disco como as ferramentas o veem: sem BOM e com `\n` (o Edit do Windows chega sem `\r`). */
export function normalizeDiskText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

function countNl(text: string, end: number): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** O texto do disco com as edições que ainda não estavam nele (o resultado chegou depois da leitura). */
function withUnreflected(text: string, edits: readonly TabEdit[], reflected: ReadonlySet<string>): string {
  let cur = text
  for (const e of edits) {
    if (reflected.has(e.tool)) continue
    if (e.kind === 'write') cur = e.content
    else if (e.kind === 'edit') cur = applyEdit(cur, e) ?? cur
  }
  return cur
}

/** O arquivo refeito do histórico: a base e as edições (um Write recomeça do conteúdo dele). */
function replay(base: string | null, edits: readonly TabEdit[]): string | null {
  let cur = base
  for (const e of edits) {
    if (e.kind === 'write') cur = e.content
    else if (e.kind === 'edit' && cur !== null) cur = applyEdit(cur, e)
    else cur = null
  }
  return cur
}

interface Reversed {
  text: string | null
  /** Edições sem posição comprovada no arquivo de agora (o texto novo sumiu ou aparece mais de uma vez). */
  lost: TabEdit[]
  /** Edições que só apagaram (texto novo vazio): sem como achar a posição. */
  cut: TabEdit[]
}

/**
 * O arquivo antes do turno, desfazendo as edições de trás para frente — só o que
 * se prova: a ocorrência do texto novo que a edição criou, quando ela é a ÚNICA no
 * arquivo. No replace_all, mais de uma ocorrência não diz quais já existiam antes
 * (desfazer todas inventaria linhas), então a edição fica sem posição.
 */
function reverse(after: string, edits: readonly TabEdit[]): Reversed {
  let cur = after
  const lost: TabEdit[] = []
  const cut: TabEdit[] = []
  for (let k = edits.length - 1; k >= 0; k--) {
    const e = edits[k]
    if (e.kind !== 'edit') return { text: null, lost, cut }
    if (e.new === '') {
      cut.unshift(e)
      continue
    }
    const at = cur.indexOf(e.new)
    if (at < 0 || cur.indexOf(e.new, at + 1) >= 0) {
      lost.unshift(e)
      continue
    }
    cur = cur.slice(0, at) + e.old + cur.slice(at + e.new.length)
  }
  return { text: cur, lost, cut }
}

const REASON_NOTE: Record<DiskReason, string> = {
  sensitive: 'Arquivo sensível: o disco não é lido, só os trechos que o Agent escreveu.',
  outside: 'Fora da pasta do projeto: só os trechos que o Agent escreveu, sem número de linha.',
  relative: 'Caminho sem pasta: só os trechos que o Agent escreveu, sem número de linha.',
  error: 'Não deu para ler o arquivo: só os trechos que o Agent escreveu, sem número de linha.',
  loading: 'Lendo o arquivo…',
  unavailable: 'Só os trechos que o Agent escreveu, sem número de linha.',
  large: 'Arquivo grande demais para abrir aqui: só os trechos que o Agent escreveu.'
}

export function fileView({ edits, base, disk, live = null }: ViewInput): FileView {
  const notebook = edits.some((e) => e.kind === 'notebook') || live?.name === 'NotebookEdit'
  // Arquivo sensível: nem o disco nem o arquivo refeito do histórico — só os trechos, sem número.
  const sensitive = disk.kind === 'none' && disk.reason === 'sensitive'
  let after: string | null = null
  let before: string | null = null
  let lost: TabEdit[] = []
  let cut: TabEdit[] = []
  if (!notebook && !sensitive && disk.kind === 'text') {
    after = withUnreflected(disk.text, edits, disk.reflected)
    // Com o disco, a versão anterior é a que ele prova. A base do histórico só vale se ela + as
    // edições dão exatamente o disco (senão houve mudança por fora: prettier, git, o usuário) —
    // ou se o turno criou o arquivo (antes não havia nada).
    const created = edits[0]?.kind === 'write' && edits[0].created
    if (base !== null && (created || replay(base, edits) === after)) before = base
    else ({ text: before, lost, cut } = reverse(after, edits))
  } else if (!notebook && !sensitive) {
    // Sem disco: o arquivo refeito do histórico (a base do turno + as edições).
    after = replay(base, edits)
    if (after !== null && base !== null) before = base
  }

  const rows: Row[] = []
  const blocks: string[] = []
  let caret: FileView['caret'] = null
  let mode: FileView['mode'] = after === null ? 'hunks' : before === null ? 'plain' : 'full'
  const gaps = new Set<number>()
  /** Ao vivo sem posição no arquivo: vira trecho solto no fim. */
  let looseLive = false
  // Onde o cursor fica no texto `after` (índice de caractere), quando o Agent digita nele.
  let caretAt = -1

  if (live && !notebook) {
    const typed = live.lines.map((l) => l ?? '')
    if (live.name === 'Write' && !sensitive) {
      // O arquivo inteiro sendo digitado: verde = linha que o arquivo de agora não tem.
      const known = after !== null ? new Set(lines(after)) : null
      const fresh = disk.kind === 'missing' || base === ''
      const total = Math.max(1, typed.length)
      for (let i = 0; i < total; i++) {
        const seen = live.lines[i] !== null && live.lines[i] !== undefined
        const t = typed[i] ?? ''
        const kind: RowKind = typed.length > 0 && !seen ? 'gap' : fresh || (known !== null && !known.has(t)) ? 'add' : 'ctx'
        rows.push({ kind, num: i + 1, src: 1, line: i })
      }
      const last = typed[typed.length - 1] ?? ''
      // Bloco fechado: o código fica até o tool-use final chegar, mas o Agent já não digita ali.
      if (!live.done) caret = { row: total - 1, ln: total, col: last.length + 1 }
      return finish({ mode: 'full', rows, before: '', after: typed.join('\n'), blocks, caret, note: null, latest: -1 })
    }
    // Edit/MultiEdit: a posição só sai do trecho antigo INTEIRO (settledOld), achado uma vez só.
    // Trecho antigo ainda chegando e nada digitado: nada a mostrar além do "digitando" da aba.
    const settled = settledOld(live)
    const old = settled ?? ''
    const complete = old !== '' && old.split('\n').length < LIVE_TAIL
    const at = after !== null && complete ? after.indexOf(old) : -1
    if (after !== null && at >= 0 && after.indexOf(old, at + 1) < 0) {
      const first = countNl(after, at)
      live.lines.forEach((l, i) => {
        if (l === null) gaps.add(first + i)
      })
      if (before === null) {
        before = after
        mode = 'full'
      }
      const text = typed.join('\n')
      after = after.slice(0, at) + text + after.slice(at + old.length)
      caretAt = at + text.length
    } else if (settled !== undefined || live.totalLines > 0) {
      looseLive = true
    }
  }

  if (after !== null && before !== null) {
    for (const op of diffLines(lines(before), lines(after))) {
      if (op.op === 'del') rows.push({ kind: 'del', num: null, src: 0, line: op.a })
      else rows.push({ kind: gaps.has(op.b) ? 'gap' : op.op === 'add' ? 'add' : 'ctx', num: op.b + 1, src: 1, line: op.b })
    }
  } else if (after !== null) {
    lines(after).forEach((_, i) => rows.push({ kind: 'ctx', num: i + 1, src: 1, line: i }))
  } else {
    edits.forEach((e, k) => hunk(rows, blocks, e, `Trecho ${k + 1} de ${edits.length}`))
  }
  if ((mode === 'full' || mode === 'plain') && rows.length === 0) rows.push({ kind: 'ctx', num: 1, src: 1, line: 0 })
  for (const e of cut) hunk(rows, blocks, e, 'Trecho apagado · sem posição no arquivo')
  for (const e of lost) hunk(rows, blocks, e, 'Mudança sem posição comprovada no arquivo de agora')

  if (caretAt >= 0 && after !== null && !live?.done) {
    const ln = countNl(after, caretAt)
    const row = rows.findIndex((r) => r.src === 1 && r.line === ln)
    const lineStart = after.lastIndexOf('\n', caretAt - 1) + 1
    caret = { row: row >= 0 ? row : rows.length - 1, ln: ln + 1, col: caretAt - lineStart + 1 }
  }
  if (live && (looseLive || notebook)) {
    const label = notebook ? 'Agent escrevendo a célula' : sensitive ? 'Agent digitando' : 'Agent digitando · posição ainda não localizada'
    // Só o trecho antigo inteiro entra (o cortado não aparece como removido).
    const old = notebook ? '' : (settledOld(live) ?? '')
    const typedText = live.lines.map((l) => l ?? '').join('\n')
    if (notebook) hunk(rows, blocks, { kind: 'notebook', id: live.toolUseId, tool: live.toolUseId, source: typedText, mode: '', pending: true }, label)
    else hunk(rows, blocks, { kind: 'edit', id: live.toolUseId, tool: live.toolUseId, old, new: typedText, all: false, pending: true }, label, true)
    const b = blocks.length - 1
    const typed = live.lines
    // Linha que o stream ainda não mostrou: placeholder. No bloco, o texto novo vem depois do antigo.
    const offset = lines(old).length
    for (let r = rows.length - 1; r >= 0 && rows[r].block === b; r--) {
      if (rows[r].kind === 'add' && typed[rows[r].line - offset] === null) rows[r].kind = 'gap'
    }
    const lastLine = typed.length > 0 ? (typed[typed.length - 1] ?? '') : ''
    if (!live.done) caret = { row: rows.length - 1, ln: null, col: lastLine.length + 1 }
  }

  let note: string | null = null
  if (disk.kind === 'none' && disk.reason === 'sensitive') note = REASON_NOTE.sensitive
  else if (mode === 'hunks') note = notebook ? 'Notebook: as células que o Agent escreveu.' : disk.kind === 'missing' ? 'O arquivo não está mais no disco: só os trechos que o Agent escreveu.' : REASON_NOTE[disk.kind === 'none' ? disk.reason : 'unavailable']
  else if (mode === 'plain') note = 'Versão anterior desconhecida: o arquivo aparece sem as cores do diff.'
  else if (lost.length > 0) note = lost.length === 1 ? '1 mudança deste turno não foi localizada no arquivo de agora.' : `${lost.length} mudanças deste turno não foram localizadas no arquivo de agora.`
  const latest = after !== null && !looseLive ? latestRow(rows, after, edits) : -1
  return finish({ mode, rows, before: before ?? '', after: after ?? '', blocks, caret, note, latest })
}

/**
 * A linha (índice em rows) da edição mais recente cujo texto novo ainda está no
 * arquivo de agora — é onde o Agent mexeu por último, para onde a tela vai ao
 * segui-lo. Começa na 1ª linha mudada do trecho (o new_string pode abrir com
 * contexto igual), com as removidas logo acima. Um Write por último: -1 (a tela
 * fica na 1ª mudança).
 */
function latestRow(rows: readonly Row[], after: string, edits: readonly TabEdit[]): number {
  for (let k = edits.length - 1; k >= 0; k--) {
    const e = edits[k]
    if (e.kind !== 'edit') return -1
    const at = e.new === '' ? -1 : after.indexOf(e.new)
    if (at < 0) continue
    const ln = countNl(after, at)
    const end = ln + countNl(e.new, e.new.length)
    let row = rows.findIndex((r) => r.src === 1 && r.line === ln)
    if (row < 0) continue
    for (let i = row; i < rows.length && !(rows[i].src === 1 && rows[i].line > end); i++) {
      if (rows[i].kind === 'add' || rows[i].kind === 'del') {
        row = i
        break
      }
    }
    while (row > 0 && rows[row - 1].kind === 'del') row--
    return row
  }
  return -1
}

/**
 * Um trecho solto: o rótulo e as linhas da própria ferramenta (old → new pela
 * LCS), sem número. O bloco guarda o texto antigo e, depois, o novo.
 */
function hunk(rows: Row[], blocks: string[], e: TabEdit, label: string, typing = false): void {
  const b = blocks.length
  rows.push({ kind: 'hunk', num: null, src: 2, line: -1, block: b, label })
  if (e.kind === 'edit') {
    // 'linha\n' → '' apaga UMA linha (lines). O que ainda está sendo digitado vem linha a linha,
    // inclusive a vazia do fim (o Agent acabou de quebrar a linha).
    const a = lines(e.old)
    const n = typing ? (e.new === '' ? [] : e.new.split('\n')) : lines(e.new)
    blocks.push([...a, ...n].join('\n'))
    for (const op of diffLines(a, n)) {
      if (op.op === 'del') rows.push({ kind: 'del', num: null, src: 2, line: op.a, block: b })
      else rows.push({ kind: op.op === 'add' ? 'add' : 'ctx', num: null, src: 2, line: a.length + op.b, block: b })
    }
    return
  }
  const text = e.kind === 'write' ? e.content : e.source
  blocks.push(text)
  lines(text).forEach((_, i) => rows.push({ kind: 'add', num: null, src: 2, line: i, block: b }))
}

function finish(v: Omit<FileView, 'added' | 'removed' | 'first'>): FileView {
  let added = 0
  let removed = 0
  let first = -1
  v.rows.forEach((r, i) => {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
    else return
    if (first < 0) first = i
  })
  return { ...v, added, removed, first }
}
