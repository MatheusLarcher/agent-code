import { describe, expect, it } from 'vitest'
import type { TabEdit } from './codeModel'
import { fileView, normalizeDiskText, type DiskState, type FileView } from './fileView'
import type { LiveBlock } from './stitch'

const edit = (id: string, old: string, neu: string, pending = false): TabEdit => ({ kind: 'edit', id, tool: id, old, new: neu, all: false, pending })
const write = (id: string, content: string, created: boolean): TabEdit => ({ kind: 'write', id, tool: id, content, created, pending: false })
const onDisk = (text: string, reflected: string[] = []): DiskState => ({ kind: 'text', text, reflected: new Set(reflected) })
const none: DiskState = { kind: 'none', reason: 'outside' }

/** As linhas como texto: número (ou ·), sinal e o texto da fonte. */
function show(v: FileView): string[] {
  const src = (r: FileView['rows'][number]): string => {
    if (r.kind === 'hunk') return `@@ ${r.label}`
    const text = r.src === 0 ? v.before : r.src === 1 ? v.after : v.blocks[r.block ?? 0]
    return text.split('\n')[r.line] ?? ''
  }
  const sign = { ctx: ' ', add: '+', del: '-', gap: '~', hunk: '' }
  return v.rows.map((r) => `${r.num ?? '·'}${sign[r.kind]}${src(r)}`)
}

const FILE = ['import a', '', 'function soma(x) {', '  return x + 1', '}', '', 'export default soma'].join('\n')
/** Rótulo do trecho cuja posição no arquivo de agora não se prova. */
const UNPROVEN = 'Mudança sem posição comprovada no arquivo de agora'

describe('fileView', () => {
  it('Write de arquivo novo: tudo verde, com os números reais', () => {
    const v = fileView({ edits: [write('w', 'a\nb', true)], base: '', disk: none })
    expect(v.mode).toBe('full')
    expect(show(v)).toEqual(['1+a', '2+b'])
    expect([v.added, v.removed, v.first]).toEqual([2, 0, 0])
  })

  it('disco lido e base desconhecida: desfaz a edição e mostra só o que mudou, com os números do arquivo', () => {
    const now = FILE.replace('  return x + 1', '  // soma um\n  return x + 2')
    const v = fileView({ edits: [edit('e', '  return x + 1', '  // soma um\n  return x + 2')], base: null, disk: onDisk(now, ['e']) })
    expect(v.mode).toBe('full')
    expect(show(v)).toEqual(['1 import a', '2 ', '3 function soma(x) {', '·-  return x + 1', '4+  // soma um', '5+  return x + 2', '6 }', '7 ', '8 export default soma'])
    expect([v.added, v.removed, v.first]).toEqual([2, 1, 3])
    expect(v.note).toBeNull()
  })

  it('latest: a tela segue a edição mais recente (1ª linha mudada do trecho, removidas acima); Write por último não tem posição', () => {
    const now = FILE.replace('import a', 'import b').replace('  return x + 1', '  return x + 2')
    const edits = [edit('e1', 'import a', 'import b'), edit('e2', 'function soma(x) {\n  return x + 1', 'function soma(x) {\n  return x + 2')]
    const v = fileView({ edits, base: null, disk: onDisk(now, ['e1', 'e2']) })
    expect(show(v)[v.latest]).toBe('·-  return x + 1')
    expect([v.first, v.latest]).toEqual([0, 4])
    // Edição que só tira linhas: a posição é a das removidas.
    const cut = fileView({ edits: [edit('c', 'x\nlixo\ny', 'x\ny')], base: 'a\nx\nlixo\ny', disk: none })
    expect(show(cut)[cut.latest]).toBe('·-lixo')
    expect(fileView({ edits: [edit('e', 'a', 'b'), write('w', 'z', false)], base: 'a', disk: none }).latest).toBe(-1)
  })

  it('sem disco, a base do histórico + as edições refazem o arquivo (números reais)', () => {
    const v = fileView({ edits: [edit('e', 'b', 'B')], base: 'a\nb\nc', disk: none })
    expect(show(v)).toEqual(['1 a', '·-b', '2+B', '3 c'])
  })

  it('sem disco e sem base: só os trechos, sem número, com o aviso', () => {
    const v = fileView({ edits: [edit('e1', 'x\ny', 'x\nY'), edit('e2', 'q', 'w')], base: null, disk: none })
    expect(v.mode).toBe('hunks')
    expect(show(v)).toEqual(['·@@ Trecho 1 de 2', '· x', '·-y', '·+Y', '·@@ Trecho 2 de 2', '·-q', '·+w'])
    expect(v.note).toContain('Fora da pasta do projeto')
  })

  it('edição cujo texto novo sumiu do arquivo não entra no diff: vira trecho solto no fim (e o aviso conta)', () => {
    const v = fileView({ edits: [edit('e1', 'a', 'b'), edit('e2', 'c', 'd')], base: null, disk: onDisk('b\nzzz', ['e1', 'e2']) })
    expect(show(v)).toEqual(['·-a', '1+b', '2 zzz', `·@@ ${UNPROVEN}`, '·-c', '·+d'])
    expect(v.note).toBe('1 mudança deste turno não foi localizada no arquivo de agora.')
  })

  it('I3: replace_all só desfaz a ocorrência que ele criou; várias (sem base que bata) viram trecho solto, sem linha inventada', () => {
    const all = (old: string, neu: string): TabEdit => ({ kind: 'edit', id: 'r', tool: 'r', old, new: neu, all: true, pending: false })
    // 'fetchUserById' já existia: desfazer todas as ocorrências inventaria '-import { getUserById }'.
    const now = 'import { fetchUserById } from "./api"\nconst u = fetchUser(1)'
    const v = fileView({ edits: [all('getUser', 'fetchUser')], base: null, disk: onDisk(now, ['r']) })
    expect(show(v)).toEqual(['1 import { fetchUserById } from "./api"', '2 const u = fetchUser(1)', `·@@ ${UNPROVEN}`, '·-getUser', '·+fetchUser'])
    expect(v.note).toBe('1 mudança deste turno não foi localizada no arquivo de agora.')
    // Uma ocorrência só: é a que a edição criou.
    const one = fileView({ edits: [all('getUser', 'fetchUser')], base: null, disk: onDisk('import { loadById } from "./api"\nconst u = fetchUser(1)', ['r']) })
    expect(show(one)).toEqual(['1 import { loadById } from "./api"', '·-const u = getUser(1)', '2+const u = fetchUser(1)'])
  })

  it('I4: com o disco lido, a base do histórico só vale se ela + as edições dão o disco; senão, vale o que o disco prova', () => {
    // Turno 1: Write; depois um prettier (fora de Write/Edit). Turno 2: o Edit do y.
    const v = fileView({ edits: [edit('e', 'const y = 2', 'const y = 3')], base: 'const x = {a:1,b:2}\nconst y = 2', disk: onDisk('const x = { a: 1, b: 2 };\nconst y = 3', ['e']) })
    expect(show(v)).toEqual(['1 const x = { a: 1, b: 2 };', '·-const y = 2', '2+const y = 3'])
    // A base que bate com o disco continua valendo (e prova até o replace_all de várias ocorrências).
    const ok = fileView({ edits: [{ kind: 'edit', id: 'r', tool: 'r', old: 'a', new: 'b', all: true, pending: false }], base: 'a\na', disk: onDisk('b\nb', ['r']) })
    expect(show(ok)).toEqual(['·-a', '·-a', '1+b', '2+b'])
    // Write no turno com o disco diferente do que ele escreveu: a versão anterior não se prova.
    const w = fileView({ edits: [write('w', 'x', false)], base: 'velho', disk: onDisk('x formatado', ['w']) })
    expect([w.mode, w.note]).toEqual(['plain', 'Versão anterior desconhecida: o arquivo aparece sem as cores do diff.'])
  })

  it('trecho só apagado (texto novo vazio) vira trecho solto no fim', () => {
    const v = fileView({ edits: [edit('e', 'tchau\n', '')], base: null, disk: onDisk('oi', ['e']) })
    expect(show(v)).toEqual(['1 oi', '·@@ Trecho apagado · sem posição no arquivo', '·-tchau'])
  })

  it('edição que ainda não estava no disco lido é aplicada por cima', () => {
    const v = fileView({ edits: [edit('e', 'b', 'B', true)], base: null, disk: onDisk('a\nb') })
    expect(show(v)).toEqual(['1 a', '·-b', '2+B'])
  })

  it('Write por cima de versão desconhecida: o arquivo sem cores e o aviso', () => {
    const v = fileView({ edits: [write('w', 'novo\ntexto', false)], base: null, disk: onDisk('novo\ntexto', ['w']) })
    expect(v.mode).toBe('plain')
    expect(show(v)).toEqual(['1 novo', '2 texto'])
    expect(v.note).toContain('Versão anterior desconhecida')
  })

  it('arquivo sensível: avisa que o disco não é lido e mostra só os trechos, sem número (nem refeito do histórico)', () => {
    const disk: DiskState = { kind: 'none', reason: 'sensitive' }
    expect(fileView({ edits: [edit('e', 'A=1', 'A=2')], base: null, disk }).note).toContain('Arquivo sensível')
    const v = fileView({ edits: [write('w', 'A=1\nB=2', false), edit('e', 'A=1', 'A=3')], base: 'velho', disk })
    expect(v.mode).toBe('hunks')
    expect(show(v)).toEqual(['·@@ Trecho 1 de 2', '·+A=1', '·+B=2', '·@@ Trecho 2 de 2', '·-A=1', '·+A=3'])
    const live: LiveBlock = { toolUseId: 'l', name: 'Write', filePath: 'C:\\p\\.env', lines: ['X=1'], totalLines: 1, done: false, at: 1 }
    const typing = fileView({ edits: [], base: null, disk, live })
    expect(show(typing)).toEqual(['·@@ Agent digitando', '·+X=1'])
    expect(typing.caret).toMatchObject({ ln: null })
  })

  it('ao vivo, Write de arquivo novo: verde, placeholder nas linhas não vistas e o cursor no fim', () => {
    const live: LiveBlock = { toolUseId: 'w', name: 'Write', filePath: 'C:\\p\\a.ts', lines: ['um', null, 'tres'], totalLines: 3, done: false, at: 1 }
    const v = fileView({ edits: [], base: null, disk: { kind: 'missing' }, live })
    expect(v.rows.map((r) => [r.kind, r.num])).toEqual([['add', 1], ['gap', 2], ['add', 3]])
    expect(v.caret).toEqual({ row: 2, ln: 3, col: 5 })
  })

  it('ao vivo, Write por cima de arquivo conhecido: verde só a linha que o arquivo não tinha', () => {
    const live: LiveBlock = { toolUseId: 'w', name: 'Write', lines: ['a', 'novo'], totalLines: 2, done: false, at: 1 }
    const v = fileView({ edits: [], base: null, disk: onDisk('a\nb'), live })
    expect(v.rows.map((r) => r.kind)).toEqual(['ctx', 'add'])
  })

  it('ao vivo, Edit achado no arquivo: troca no lugar, diff com números e Ln/Col do cursor', () => {
    const live: LiveBlock = { toolUseId: 'e', name: 'Edit', oldText: '  return x + 1', lines: ['  return x +'], totalLines: 1, done: false, at: 1 }
    const v = fileView({ edits: [], base: null, disk: onDisk(FILE), live })
    expect(show(v).slice(2, 6)).toEqual(['3 function soma(x) {', '·-  return x + 1', '4+  return x +', '5 }'])
    expect(v.caret).toEqual({ row: 4, ln: 4, col: 13 })
  })

  it('ao vivo, Edit sem posição conhecida: trecho solto no fim, sem número', () => {
    const live: LiveBlock = { toolUseId: 'e', name: 'Edit', oldText: 'velho', lines: ['novo', null], totalLines: 2, done: false, at: 1 }
    const v = fileView({ edits: [], base: null, disk: none, live })
    expect(show(v)).toEqual(['·@@ Agent digitando · posição ainda não localizada', '·-velho', '·+novo', '·~'])
    expect(v.caret).toEqual({ row: 3, ln: null, col: 1 })
  })

  it('I1: Edit ao vivo com o trecho antigo ainda chegando não é localizado nem aplicado; sem ele, só o digitado, sem número', () => {
    const now = 'export function total(items) {\n  let s = 0\n  for (const i of items) s += i.price\n  return s\n}'
    const disk = onDisk(now)
    const still = show(fileView({ edits: [], base: null, disk }))
    // Contrato antigo do main: old_string pela metade e nada digitado (totalLines 0).
    const live: LiveBlock = { toolUseId: 'e', name: 'Edit', filePath: 'C:\\p\\a.ts', oldText: '  let s = 0\n  for (const i of it', lines: [], totalLines: 0, done: false, at: 1 }
    const partial = fileView({ edits: [], base: null, disk, live })
    expect([show(partial), partial.caret, partial.added, partial.removed]).toEqual([still, null, 0, 0])
    // Contrato novo (o trecho antigo só vem inteiro): sem ele e já digitando, só o digitado, solto e sem número.
    const typing = fileView({ edits: [], base: null, disk, live: { ...live, oldText: undefined, lines: ['  // novo'], totalLines: 1 } })
    expect(show(typing).slice(-2)).toEqual(['·@@ Agent digitando · posição ainda não localizada', '·+  // novo'])
    expect(typing.caret).toMatchObject({ ln: null })
    // Trecho antigo inteiro e o novo já começou: no lugar, com o número real.
    const placed = fileView({ edits: [], base: null, disk, live: { ...live, oldText: '  let s = 0\n  for (const i of items) s += i.price', lines: ['  // soma'], totalLines: 1 } })
    expect(show(placed).slice(1, 4)).toEqual(['·-  let s = 0', '·-  for (const i of items) s += i.price', '2+  // soma'])
  })

  it('o texto do disco perde o BOM e o \\r do Windows', () => {
    expect(normalizeDiskText('\uFEFFa\r\nb\rc\n')).toBe('a\nb\nc\n')
  })
})
