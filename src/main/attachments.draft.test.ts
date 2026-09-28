import { describe, it, expect, vi } from 'vitest'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  buildAttachmentNote,
  discardDraftAttachments,
  draftFileName,
  promoteDraftAttachments,
  stashDraftAttachment
} from './attachments'

/** Rascunho com anexo: os bytes vão para o disco e o rascunho guarda só o caminho. */
const b64 = (s: string): string => Buffer.from(s).toString('base64')
// Fora do Electron, userData é <tmp>/agent-code (ver userDataDir em attachments.ts).
const ATTACHMENTS = join(tmpdir(), 'agent-code', 'attachments')
const win = process.platform === 'win32'

async function stash(convId: string, name: string, mediaType: string, data = 'x'): Promise<string> {
  const r = await stashDraftAttachment(convId, { name, mediaType, data: b64(data) })
  if (!r.ok) throw new Error(`stash falhou: ${r.error}`)
  return r.path
}
/** O caminho que o renderer manda no envio (sentCopyPath): a cópia sem o `rascunho/`. */
const sentPathOf = (draftPath: string): string => join(dirname(dirname(draftPath)), basename(draftPath))

describe('stashDraftAttachment', () => {
  it('grava os bytes em attachments/<conversa>/rascunho/ com o nome original saneado', async () => {
    const r = await stashDraftAttachment('cmg1abc2def', { name: '../../fora.png', mediaType: 'image/png', data: b64('PNG!') })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(dirname(r.path)).toBe(join(ATTACHMENTS, 'cmg1abc2def', 'rascunho'))
    expect(basename(r.path)).toMatch(/^\d+-\d+-fora\.png$/)
    expect((await readFile(r.path)).toString()).toBe('PNG!')
  })

  it("convId fora do formato real ('..', '.', 'a/..', barras) é recusado e nada é gravado fora", async () => {
    const before = existsSync(ATTACHMENTS) ? await readdir(ATTACHMENTS) : []
    for (const convId of ['..', '.', 'a/..', '../..', 'a\\..\\..', '/etc', 'C:\\x', 'a/b', 'a\\b', '', ' c1', 'c1 ', 'c.1', 'x'.repeat(201), 42, null]) {
      expect(await stashDraftAttachment(convId, { name: 'a.png', mediaType: 'image/png', data: b64('x') })).toEqual({
        ok: false,
        error: 'Conversa inválida.'
      })
    }
    expect(existsSync(join(tmpdir(), 'agent-code', 'rascunho'))).toBe(false)
    expect(existsSync(join(ATTACHMENTS, 'rascunho'))).toBe(false)
    expect(existsSync(ATTACHMENTS) ? await readdir(ATTACHMENTS) : []).toEqual(before)
  })

  it('ids reais de conversa passam (uid, tarefa MCP, conflito, UUID)', async () => {
    for (const convId of ['cmg1abc2def', 'c-0a1b2c3d4e5f', 'cmg1abc2def-conflict-1a2b3c4d', '2f1c7e0a-3b4d-4e5f-9a8b-7c6d5e4f3a2b']) {
      const r = await stashDraftAttachment(convId, { name: 'a.png', mediaType: 'image/png', data: b64('x') })
      expect(r.ok).toBe(true)
    }
  })

  it('a extensão ORIGINAL fica, qualquer que seja o tipo: notes.md sem tipo, dados.csv como vnd.ms-excel, .py/.ts/.svg/.log/.yaml', async () => {
    expect(basename(await stash('c1', 'notes.md', 'application/octet-stream'))).toMatch(/^\d+-\d+-notes\.md$/)
    expect(basename(await stash('c1', 'dados.csv', 'application/vnd.ms-excel'))).toMatch(/^\d+-\d+-dados\.csv$/)
    expect(basename(await stash('c1', 'notes.md', ''))).toMatch(/^\d+-\d+-notes\.md$/)
    for (const name of ['script.py', 'app.ts', 'logo.svg', 'erro.log', 'ci.yaml', 'Makefile', 'relatório final.pdf']) {
      const p = await stash('c1', name, 'application/octet-stream')
      expect(basename(p)).toBe(`${basename(p).match(/^\d+-\d+-/)![0]}${name.replace(/ /g, '_')}`)
    }
  })

  it('recusa extensão proibida (em qualquer caixa, com ponto no fim ou escondida em ":"), nome com ponto no início e nome reservado', async () => {
    for (const ext of ['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'lnk', 'ps1', 'vbs', 'vbe', 'hta', 'dll', 'cpl', 'reg', 'pif']) {
      const r = await stashDraftAttachment('c1', { name: `virus.${ext}`, mediaType: 'image/png', data: b64('MZ') })
      expect(r).toEqual({ ok: false, error: `Tipo de arquivo não aceito: .${ext}` })
    }
    for (const name of ['VIRUS.EXE', 'a.exe.', 'a.exe . .', 'a.txt:b.exe', 'fatura\u202Etxt.exe']) {
      expect((await stashDraftAttachment('c1', { name, mediaType: 'text/plain', data: b64('x') })).ok).toBe(false)
    }
    // o corte do nome longo não pode deixar um .exe no fim
    const sneaky = `${'a'.repeat(116)}.exe${'Z'.repeat(60)}`
    expect((await stashDraftAttachment('c1', { name: sneaky, mediaType: 'text/plain', data: b64('x') })).ok).toBe(false)
    expect(await stashDraftAttachment('c1', { name: '.htaccess', mediaType: 'text/plain', data: b64('x') })).toEqual({
      ok: false,
      error: 'Nome de arquivo não aceito (começa com ponto).'
    })
    expect((await stashDraftAttachment('c1', { name: '.env', mediaType: 'text/plain', data: b64('x') })).ok).toBe(false)
    for (const name of ['CON', 'nul.txt', 'COM1', 'lpt9.md', 'Aux.csv', 'prn']) {
      expect(await stashDraftAttachment('c1', { name, mediaType: 'text/plain', data: b64('x') })).toEqual({
        ok: false,
        error: 'Nome de arquivo reservado do Windows.'
      })
    }
  })

  it('saneia: sem controle/bidi nem reservados do Windows, sem ponto final, com teto; o arquivo fica na pasta certa', async () => {
    const weird = await stash('c1', 'a/../..\\b:c*.png', 'image/png')
    expect(dirname(weird)).toBe(join(ATTACHMENTS, 'c1', 'rascunho'))
    expect(basename(weird)).toMatch(/^\d+-\d+-b_c_\.png$/)
    const ctl = draftFileName('re\u0000la\u202Etório<>|?"\t.md.')
    expect(ctl.ok && ctl.name.replace(/^\d+-\d+-/, '')).toBe('relatório_____.md')
    const long = draftFileName(`${'n'.repeat(300)}.md`)
    expect(long.ok && long.name.replace(/^\d+-\d+-/, '')).toMatch(/^n{117}\.md$/)
    const img = draftFileName('colada', 'image/png')
    expect(img.ok && img.name).toMatch(/-colada\.png$/)
  })

  it('recusa anexo inválido ou grande demais', async () => {
    expect(await stashDraftAttachment('c1', { name: 'a', mediaType: 'image/png' })).toEqual({ ok: false, error: 'Anexo inválido.' })
    expect(await stashDraftAttachment('c1', null)).toEqual({ ok: false, error: 'Anexo inválido.' })
    const huge = { name: 'a', mediaType: 'image/png', data: 'A'.repeat(70 * 1024 * 1024 + 8) }
    expect(await stashDraftAttachment('c1', huge)).toEqual({ ok: false, error: 'Anexo grande demais para o rascunho.' })
  })
})

describe('envio: a cópia do rascunho é MOVIDA para a pasta do envio', () => {
  it('notes.md sem tipo e dados.csv como vnd.ms-excel chegam ao agente como …-notes.md e …-dados.csv, fora do rascunho/', async () => {
    const md = await stash('csend1', 'notes.md', 'application/octet-stream', '# notas')
    const csv = await stash('csend1', 'dados.csv', 'application/vnd.ms-excel', 'a;b')
    const note = buildAttachmentNote('veja {{midia:1}} e {{midia:2}}', [
      { name: 'notes.md', path: sentPathOf(md), label: 'midia:1 = notes.md' },
      { name: 'dados.csv', path: csv, label: 'midia:2 = dados.csv' } // caminho antigo (ainda no rascunho) também vale
    ])
    const lines = note.split('\n').filter((l) => l.startsWith('- midia:'))
    expect(lines).toEqual([`- midia:1 = notes.md: ${sentPathOf(md)}`, `- midia:2 = dados.csv: ${sentPathOf(csv)}`])
    expect(lines[0]).toMatch(/-notes\.md$/)
    expect(lines[1]).toMatch(/-dados\.csv$/)
    for (const p of [md, csv]) {
      expect(existsSync(p)).toBe(false) // nada enviado fica em rascunho/
      expect(dirname(sentPathOf(p))).toBe(join(ATTACHMENTS, 'csend1'))
    }
    expect((await readFile(sentPathOf(md))).toString()).toBe('# notas')
    // de novo (retentativa / fila): idempotente, mesmo caminho
    expect(buildAttachmentNote('', [{ name: 'notes.md', path: sentPathOf(md) }])).toContain(sentPathOf(md))
  })

  it('o IPC do envio move só cópias da conversa pedida; caminho de fora e de outra conversa ficam', async () => {
    const mine = await stash('csend2', 'a.txt', 'text/plain')
    const other = await stash('csend3', 'b.txt', 'text/plain')
    const out = promoteDraftAttachments('csend2', [mine, other, join(ATTACHMENTS, 'csend2', 'rascunho', '..', '..', 'x'), 42])
    expect(out).toEqual([sentPathOf(mine)])
    expect(existsSync(sentPathOf(mine))).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(promoteDraftAttachments('..', [other])).toEqual([])
    expect(promoteDraftAttachments('csend2', [mine])).toEqual([sentPathOf(mine)]) // já movido: mesmo destino
  })

  it('caminho que não é cópia do rascunho vai na nota como veio (sem tocar no disco)', () => {
    expect(buildAttachmentNote('', [{ name: 'x.txt', path: 'C:\\Users\\eu\\x.txt' }])).toContain('- x.txt: C:\\Users\\eu\\x.txt')
  })
})

describe('discardDraftAttachments', () => {
  it('apaga só cópias do rascunho da própria conversa', async () => {
    const mine = await stash('c7', 'a.png', 'image/png')
    const other = await stash('c8', 'b.png', 'image/png')
    // Cópia do ENVIO (direto em attachments/c7/) e arquivo qualquer: nunca.
    const sentCopy = join(ATTACHMENTS, 'c7', '1-1-enviado.csv')
    await mkdir(dirname(sentCopy), { recursive: true })
    await writeFile(sentCopy, 'x')
    const n = await discardDraftAttachments('c7', [
      mine,
      other,
      sentCopy,
      join(ATTACHMENTS, 'c7', 'rascunho', '..', '1-1-enviado.csv'),
      join(ATTACHMENTS, 'c7', 'rascunho', 'nao-e-copia.txt'),
      42
    ])
    expect(n).toBe(1)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(sentCopy)).toBe(true)
    expect(await discardDraftAttachments('..', [other])).toBe(0)
    expect(await discardDraftAttachments('c8', 'x')).toBe(0)
  })

  it('o arquivo enviado nunca é apagado: nem pelo caminho do rascunho, nem em outra caixa, nem depois de reiniciar', async () => {
    const draft = await stash('c9', 'r.csv', 'text/csv', 'a;b')
    const sent = sentPathOf(draft)
    buildAttachmentNote('olha', [{ name: 'r.csv', path: sent, label: 'midia:1 = r.csv' }])
    const variants = [
      draft,
      sent,
      draft.replace('rascunho', 'RASCUNHO'),
      draft.replace(`${join('attachments', 'c9')}`, join('ATTACHMENTS', 'C9')),
      sent.toUpperCase(),
      join(dirname(draft), '.', basename(draft)),
      join(dirname(draft), '..', basename(draft))
    ]
    expect(await discardDraftAttachments('c9', variants)).toBe(0)
    expect(await discardDraftAttachments('C9', variants)).toBe(0)
    // "reiniciar": módulo recarregado, nenhum estado em memória
    vi.resetModules()
    const fresh = await import('./attachments')
    expect(await fresh.discardDraftAttachments('c9', variants)).toBe(0)
    expect((await readFile(sent)).toString()).toBe('a;b')
  })

  it.runIf(win)('no Windows a comparação ignora a caixa: a cópia do rascunho em outra caixa é achada e apagada', async () => {
    const draft = await stash('c10', 'q.txt', 'text/plain')
    expect(await discardDraftAttachments('c10', [draft.replace('rascunho', 'RaScUnHo')])).toBe(1)
    expect(existsSync(draft)).toBe(false)
  })

  it('link simbólico no rascunho: sai só o link, o alvo fica', async (ctx) => {
    const victim = join(tmpdir(), 'agent-code', `vitima-${Date.now()}.txt`)
    await writeFile(victim, 'importante')
    const dir = join(ATTACHMENTS, 'c11', 'rascunho')
    await mkdir(dir, { recursive: true })
    const link = join(dir, `${Date.now()}-1-link.txt`)
    try {
      symlinkSync(victim, link, 'file')
    } catch {
      ctx.skip() // sem permissão para criar link simbólico nesta máquina
      return
    }
    expect(await discardDraftAttachments('c11', [link])).toBe(1)
    expect(existsSync(link)).toBe(false)
    expect((await readFile(victim)).toString()).toBe('importante')
  })
})
