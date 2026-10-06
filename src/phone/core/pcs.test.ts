import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_KEY, DEVICE_KEY, LAST_CONV_KEY, loadConfig, type PairConfig } from './config'
import {
  PCS_KEY,
  activePc,
  loadLastConv,
  loadPcs,
  namePcIfUnnamed,
  otherPcs,
  pcConfig,
  pcLabel,
  pcsStore,
  removePc,
  renamePc,
  saveLastConv,
  setActivePc,
  upsertPc,
  type SavedPc
} from './pcs'

const A: PairConfig = { base: 'https://relay.x', token: 'tA', lan: '192.168.0.10:8765' }
const B: PairConfig = { base: 'https://relay.y', token: 'tB', lan: '' }
const C: PairConfig = { base: 'http://10.0.0.5:8765', token: 'tC', lan: '10.0.0.5:8765' }

/** O que está gravado em `agent-remote-pcs` e no espelho `agent-remote-config`. */
const savedList = (): unknown => JSON.parse(localStorage.getItem(PCS_KEY) ?? 'null')
const savedConfig = (): unknown => JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null')
const raw = (): Array<string | null> => [localStorage.getItem(PCS_KEY), localStorage.getItem(CONFIG_KEY)]
const seed = (pcs: unknown[], activeId: string | null = null): void => localStorage.setItem(PCS_KEY, JSON.stringify({ pcs, activeId }))
const entry = (over: Partial<SavedPc> = {}): SavedPc => ({
  id: 'id', nome: null, base: 'https://relay.x', token: 'tok', lan: '', lastConv: null, addedAt: 1, lastUsedAt: 1, ...over
})

/** tA (ativo, usado em 400), tB (200) e tC (300), pelo caminho normal da API. */
function threePcs(): { a: SavedPc; b: SavedPc; c: SavedPc } {
  const a = upsertPc(A, 100).pc
  const b = upsertPc(B, 200).pc
  const c = upsertPc(C, 300).pc
  setActivePc(a.id, 400)
  return { a, b, c }
}

describe('lista de PCs salvos (filiais)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('as chaves do app antigo não mudam; a lista usa uma chave nova', () => {
    expect(CONFIG_KEY).toBe('agent-remote-config')
    expect(LAST_CONV_KEY).toBe('agent-remote-last-conv')
    expect(DEVICE_KEY).toBe('agent-remote-device')
    expect(PCS_KEY).toBe('agent-remote-pcs')
  })

  describe('loadPcs: migração e validação', () => {
    it('migra o pareamento único: 1 PC ativo, sem nome, com a última conversa', () => {
      vi.spyOn(Date, 'now').mockReturnValue(5_000)
      localStorage.setItem(CONFIG_KEY, JSON.stringify(A))
      localStorage.setItem(LAST_CONV_KEY, 'c7')
      localStorage.setItem(DEVICE_KEY, 'ph-1')

      const list = loadPcs()
      expect(list.pcs).toHaveLength(1)
      const pc = list.pcs[0]
      expect(pc.id).toMatch(/^pc-/)
      expect(list.activeId).toBe(pc.id)
      expect(pc).toEqual({ id: pc.id, nome: null, base: A.base, token: 'tA', lan: A.lan, lastConv: 'c7', addedAt: 5_000, lastUsedAt: 5_000 })
      expect(savedList()).toEqual({ pcs: [pc], activeId: pc.id })
      // quem voltar ao APK antigo continua pareado; o resto das chaves antigas fica como estava
      expect(loadConfig()).toEqual(A)
      expect(localStorage.getItem(LAST_CONV_KEY)).toBe('c7')
      expect(localStorage.getItem(DEVICE_KEY)).toBe('ph-1')

      expect(loadPcs()).toEqual(list) // 2º load: o mesmo PC (mesmo id), sem duplicar
      expect(savedList()).toEqual({ pcs: [pc], activeId: pc.id })
    })

    it('migra mesmo sem última conversa guardada', () => {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(B))
      expect(loadPcs().pcs[0]).toMatchObject({ token: 'tB', lan: '', lastConv: null })
    })

    it('sem nada salvo: lista vazia, sem criar agent-remote-pcs nem agent-remote-config', () => {
      expect(loadPcs()).toEqual({ pcs: [], activeId: null })
      expect(localStorage.getItem(PCS_KEY)).toBeNull()
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull()
      expect(localStorage.length).toBe(0)
    })

    it('config sem endereço ou sem token não vira PC', () => {
      for (const cfg of [{ base: '', token: 'tA', lan: '' }, { base: 'https://relay.x', token: '', lan: '' }]) {
        localStorage.clear()
        localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
        expect(loadPcs()).toEqual({ pcs: [], activeId: null })
        expect(localStorage.getItem(PCS_KEY)).toBeNull()
        expect(savedConfig()).toEqual(cfg)
      }
    })

    it('JSON corrompido ou com formato errado cai na migração (1 PC da config)', () => {
      const bad = ['{nope', 'null', '"x"', '42', '[]', '{}', '{"pcs":"x"}', '{"pcs":[]}', '{"pcs":[null,1,"a",{}]}']
      for (const text of bad) {
        localStorage.clear()
        localStorage.setItem(CONFIG_KEY, JSON.stringify(A))
        localStorage.setItem(PCS_KEY, text)
        const list = loadPcs()
        expect(list.pcs.map((p) => p.token), text).toEqual(['tA'])
        expect(list.activeId, text).toBe(list.pcs[0].id)
        expect(savedList(), text).toEqual(list) // a lista ruim foi trocada pela migrada
      }
    })

    it('lista ruim e nada para migrar: vazia, e a chave ruim não é mexida', () => {
      localStorage.setItem(PCS_KEY, '{nope')
      expect(loadPcs()).toEqual({ pcs: [], activeId: null })
      expect(localStorage.getItem(PCS_KEY)).toBe('{nope')
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull()
    })

    it('descarta entradas inválidas, normaliza as válidas e troca o ativo que não existe', () => {
      const ok = (over: object): object => ({ ...entry(), ...over })
      seed(
        [
          ok({ id: 'a', token: 'tA', lastUsedAt: 10, nome: '  Casa  ', lan: 5, lastConv: 7, addedAt: 'x' }),
          null,
          'texto',
          7,
          [],
          ok({ id: '', token: 'tZ' }), // id vazio
          ok({ id: 'sem-token', token: '' }),
          ok({ id: 'token-num', token: 9 }),
          ok({ id: 'base-num', token: 'tY', base: 3 }),
          { ...ok({ token: 'tW' }), id: undefined }, // sem id
          ok({ id: 'a2', token: 'tA', lastUsedAt: 99 }), // token repetido: fica a primeira
          ok({ id: 'b', token: 'tB', lastUsedAt: 30, nome: '   ' }),
          ok({ id: 'c', token: 'tC', base: '', lastUsedAt: null, nome: 5 })
        ],
        'fantasma'
      )
      const list = loadPcs()
      expect(list.pcs.map((p) => p.id)).toEqual(['a', 'b', 'c'])
      expect(list.pcs[0]).toEqual({ id: 'a', nome: 'Casa', base: 'https://relay.x', token: 'tA', lan: '', lastConv: null, addedAt: 0, lastUsedAt: 10 })
      expect(list.pcs[1].nome).toBeNull()
      expect(list.pcs[2]).toMatchObject({ base: '', lastUsedAt: 0, nome: null }) // base vazia ainda é string; nome que não é texto some
      expect(list.activeId).toBe('b') // 'fantasma' não existe: vale o de maior lastUsedAt
      expect(pcsStore.get()).toEqual(list)
    })

    it('id repetido: fica a primeira entrada', () => {
      seed([entry({ id: 'x', token: 'tA' }), entry({ id: 'x', token: 'tB' })], 'x')
      expect(loadPcs().pcs.map((p) => p.token)).toEqual(['tA'])
    })

    it('lista válida: o ativo salvo vale (mesmo sem ser o mais recente) e ler não grava nada', () => {
      seed([entry({ id: 'a', token: 'tA', lastUsedAt: 10 }), entry({ id: 'b', token: 'tB', lastUsedAt: 30 })], 'a')
      const set = vi.spyOn(Storage.prototype, 'setItem')
      const del = vi.spyOn(Storage.prototype, 'removeItem')
      const list = loadPcs()
      expect(list.activeId).toBe('a')
      expect(list.pcs.map((p) => p.id)).toEqual(['a', 'b'])
      expect(set).not.toHaveBeenCalled()
      expect(del).not.toHaveBeenCalled()
      expect(pcsStore.get()).toEqual(list)
    })

    it('activeId nulo: vale o PC de maior lastUsedAt', () => {
      seed([entry({ id: 'a', token: 'tA', lastUsedAt: 10 }), entry({ id: 'b', token: 'tB', lastUsedAt: 30 })], null)
      expect(loadPcs().activeId).toBe('b')
    })
  })

  describe('upsertPc', () => {
    it('token já salvo: atualiza base e lan, mantém o resto, não duplica', () => {
      const first = upsertPc(A, 1000).pc
      setActivePc(first.id, 1100)
      renamePc(first.id, 'Casa')
      saveLastConv('tA', 'c1')

      const out = upsertPc({ base: 'https://novo.relay', token: 'tA', lan: '10.1.1.1:8765' }, 9000)
      expect(out.existed).toBe(true)
      expect(out.pc).toEqual({
        id: first.id, nome: 'Casa', base: 'https://novo.relay', token: 'tA', lan: '10.1.1.1:8765', lastConv: 'c1', addedAt: 1000, lastUsedAt: 1100
      })
      expect(loadPcs().pcs).toEqual([out.pc])
      // o PC ativo mudou de endereço: o espelho do app antigo acompanha
      expect(savedConfig()).toEqual({ base: 'https://novo.relay', token: 'tA', lan: '10.1.1.1:8765' })
    })

    it('token novo: entra no fim, sem nome, com id próprio, e não vira o ativo', () => {
      const a = upsertPc(A, 100).pc
      setActivePc(a.id, 150)
      const out = upsertPc(B, 200)
      expect(out.existed).toBe(false)
      expect(out.pc).toEqual({ id: out.pc.id, nome: null, base: B.base, token: 'tB', lan: '', lastConv: null, addedAt: 200, lastUsedAt: 200 })
      expect(out.pc.id).toMatch(/^pc-/)
      expect(out.pc.id).not.toBe(a.id)
      const list = loadPcs()
      expect(list.pcs.map((p) => p.token)).toEqual(['tA', 'tB'])
      expect(list.activeId).toBe(a.id)
      expect(savedConfig()).toEqual(A)
    })

    it('o primeiro PC não vira ativo sozinho: quem ativa é o setActivePc', () => {
      const a = upsertPc(A, 100).pc
      expect(savedList()).toEqual({ pcs: [a], activeId: null })
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull()
      setActivePc(a.id, 110)
      expect(savedConfig()).toEqual(A)
    })

    it('sobre o pareamento antigo (sem lista) não perde o PC que já estava pareado', () => {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(A))
      expect(upsertPc(B, 50).existed).toBe(false)
      const list = loadPcs()
      expect(list.pcs.map((p) => p.token)).toEqual(['tA', 'tB'])
      expect(list.activeId).toBe(list.pcs[0].id) // o antigo segue ativo
      expect(savedConfig()).toEqual(A)
    })
  })

  describe('setActivePc', () => {
    it('ativa o PC, marca o uso e espelha o ativo em agent-remote-config', () => {
      const a = upsertPc(A, 100).pc
      const b = upsertPc(B, 200).pc
      expect(setActivePc(b.id, 300)).toEqual({ ...b, lastUsedAt: 300 })
      expect(loadPcs()).toEqual({ pcs: [a, { ...b, lastUsedAt: 300 }], activeId: b.id })
      expect(savedConfig()).toEqual({ base: B.base, token: 'tB', lan: '' })

      setActivePc(a.id, 400)
      expect(loadPcs().activeId).toBe(a.id)
      expect(savedConfig()).toEqual({ base: A.base, token: 'tA', lan: A.lan })
    })

    it('id inexistente: devolve null e não muda nada', () => {
      const a = upsertPc(A, 100).pc
      setActivePc(a.id, 110)
      const before = raw()
      expect(setActivePc('nao-existe', 999)).toBeNull()
      expect(raw()).toEqual(before)
    })
  })

  describe('removePc', () => {
    it('do ativo: o de lastUsedAt mais recente assume (com lastUsedAt = agora) e o espelho acompanha', () => {
      const { a, b, c } = threePcs()
      const out = removePc(a.id, 500)
      expect(out.removed).toMatchObject({ id: a.id, token: 'tA' })
      expect(out.wasActive).toBe(true)
      expect(out.next).toEqual({ ...c, lastUsedAt: 500 })
      const list = loadPcs()
      expect(list.pcs.map((p) => p.id)).toEqual([b.id, c.id])
      expect(list.activeId).toBe(c.id)
      expect(list.pcs.map((p) => p.lastUsedAt)).toEqual([200, 500]) // o outro não é tocado
      expect(savedConfig()).toEqual(pcConfig(c))
    })

    it('de um PC que não é o ativo: o ativo continua o mesmo, sem trocar lastUsedAt', () => {
      const { a, b, c } = threePcs()
      const out = removePc(b.id, 500)
      expect(out.removed).toMatchObject({ id: b.id })
      expect(out.wasActive).toBe(false)
      expect(out.next).toEqual({ ...a, lastUsedAt: 400 })
      expect(loadPcs()).toEqual({ pcs: [{ ...a, lastUsedAt: 400 }, c], activeId: a.id })
      expect(savedConfig()).toEqual(pcConfig(a))
    })

    it('id inexistente: nada removido, nada gravado, next é o ativo atual', () => {
      const { a } = threePcs()
      const before = raw()
      expect(removePc('nao-existe', 500)).toEqual({ removed: null, wasActive: false, next: { ...a, lastUsedAt: 400 } })
      expect(raw()).toEqual(before)
    })

    it('do último PC: lista vazia, sem ativo, agent-remote-config removido e o id do aparelho intacto', () => {
      localStorage.setItem(DEVICE_KEY, 'ph-1')
      const a = upsertPc(A, 100).pc
      setActivePc(a.id, 110)
      expect(savedConfig()).toEqual(A)

      const out = removePc(a.id, 200)
      expect(out).toMatchObject({ removed: { id: a.id }, wasActive: true, next: null })
      expect(savedList()).toEqual({ pcs: [], activeId: null })
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull()
      expect(localStorage.getItem(DEVICE_KEY)).toBe('ph-1')
      // sem o espelho para migrar, o PC removido não volta
      expect(loadPcs()).toEqual({ pcs: [], activeId: null })
      expect(pcsStore.get()).toEqual({ pcs: [], activeId: null })
    })
  })

  describe('renamePc e namePcIfUnnamed', () => {
    it('renamePc apara, limita a 60 caracteres e recusa vazio ou id inexistente', () => {
      const { pc } = upsertPc(A, 1)
      expect(renamePc(pc.id, `  ${'x'.repeat(80)}  `)).toBe(true)
      expect(loadPcs().pcs[0].nome).toBe('x'.repeat(60))
      expect(renamePc(pc.id, '  Empresa  ')).toBe(true)
      expect(loadPcs().pcs[0].nome).toBe('Empresa')

      const before = raw()
      expect(renamePc(pc.id, '   ')).toBe(false)
      expect(renamePc('nao-existe', 'Casa')).toBe(false)
      expect(raw()).toEqual(before)
      expect(loadPcs().pcs[0].nome).toBe('Empresa')
    })

    it('namePcIfUnnamed grava o nome do host quando o PC ainda não tem nome; vazio é ignorado', () => {
      upsertPc(A, 1)
      for (const empty of ['', '   ', null, undefined, 42 as unknown as string]) expect(namePcIfUnnamed('tA', empty)).toBe(false)
      expect(loadPcs().pcs[0].nome).toBeNull()

      expect(namePcIfUnnamed('tA', '  Matheus-2D ')).toBe(true)
      expect(loadPcs().pcs[0].nome).toBe('Matheus-2D')
      expect(namePcIfUnnamed('tX', 'Qualquer')).toBe(false) // token desconhecido
    })

    it('namePcIfUnnamed limita o nome a 60 caracteres', () => {
      upsertPc(A, 1)
      expect(namePcIfUnnamed('tA', 'h'.repeat(100))).toBe(true)
      expect(loadPcs().pcs[0].nome).toBe('h'.repeat(60))
    })

    it('o nome padrão do host não sobrescreve o nome editado', () => {
      const { pc } = upsertPc(A, 1)
      expect(renamePc(pc.id, 'Empresa')).toBe(true)
      expect(namePcIfUnnamed('tA', 'Matheus-2D')).toBe(false)
      expect(loadPcs().pcs[0].nome).toBe('Empresa')
      expect(renamePc(pc.id, '  ')).toBe(false)
      expect(loadPcs().pcs[0].nome).toBe('Empresa')
    })

    it('nomear não mexe no espelho do app antigo (só base/token/lan)', () => {
      const { pc } = upsertPc(A, 1)
      setActivePc(pc.id, 2)
      renamePc(pc.id, 'Casa')
      expect(savedConfig()).toEqual(A)
    })
  })

  describe('última conversa por PC', () => {
    it('cada PC guarda a sua (pelo token); a chave antiga acompanha a última gravada', () => {
      upsertPc(A, 100)
      upsertPc(B, 200)
      saveLastConv('tA', 'c1')
      saveLastConv('tB', 'c9')
      expect(loadLastConv('tA')).toBe('c1')
      expect(loadLastConv('tB')).toBe('c9')
      expect(localStorage.getItem(LAST_CONV_KEY)).toBe('c9')
      expect(loadPcs().pcs.map((p) => p.lastConv)).toEqual(['c1', 'c9'])
      expect(loadLastConv('desconhecido')).toBe('c9') // sem PC com esse token: a chave antiga
    })

    it('PC que ainda não abriu conversa não herda a do outro (os ids não existem lá)', () => {
      upsertPc(A, 100)
      upsertPc(B, 200)
      saveLastConv('tA', 'c1')
      expect(loadLastConv('tB')).toBeNull()
    })

    it('grava só no PC do token, mesmo que ele não seja o ativo (resposta em voo do PC anterior)', () => {
      const a = upsertPc(A, 100).pc
      const b = upsertPc(B, 200).pc
      setActivePc(b.id, 300)
      saveLastConv('tA', 'c1')
      const list = loadPcs()
      expect(list.pcs.map((p) => p.lastConv)).toEqual(['c1', null])
      expect(list.activeId).toBe(b.id)
      expect(a.token).toBe('tA')
      expect(savedConfig()).toEqual(B)
    })

    it('sem lista salva: cai na chave antiga e não cria a lista só por abrir uma conversa', () => {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(A))
      saveLastConv('tA', 'c3')
      expect(localStorage.getItem(LAST_CONV_KEY)).toBe('c3')
      expect(loadLastConv('tA')).toBe('c3')
      expect(loadLastConv('')).toBe('c3')
      expect(localStorage.getItem(PCS_KEY)).toBeNull()
    })

    it('sem nenhum valor salvo: nulo', () => {
      expect(loadLastConv('tA')).toBeNull()
    })
  })

  describe('leitura da lista', () => {
    it('activePc e pcConfig', () => {
      expect(activePc({ pcs: [], activeId: null })).toBeNull()
      const a = upsertPc(A, 100).pc
      const b = upsertPc(B, 200).pc
      expect(activePc({ pcs: [a, b], activeId: b.id })).toBe(b)
      expect(activePc({ pcs: [a, b], activeId: 'x' })).toBeNull()
      expect(activePc({ pcs: [a, b], activeId: null })).toBeNull()
      expect(pcConfig(a)).toEqual(A)
    })

    it('pcLabel: "PC N" pela posição na lista quando sem nome; com nome, o nome', () => {
      const a = upsertPc(A, 100).pc
      const b = upsertPc(B, 200).pc
      let list = loadPcs()
      expect(pcLabel(a, list)).toBe('PC 1')
      expect(pcLabel(b, list)).toBe('PC 2')
      renamePc(b.id, 'Empresa')
      list = loadPcs()
      expect(pcLabel(list.pcs[1], list)).toBe('Empresa')
      expect(pcLabel(list.pcs[0], list)).toBe('PC 1')
    })

    it('otherPcs: tudo menos o ativo, do mais recente ao mais antigo, sem mexer na lista', () => {
      const { a, b, c } = threePcs()
      const list = loadPcs()
      expect(otherPcs(list).map((p) => p.id)).toEqual([c.id, b.id])
      expect(list.pcs.map((p) => p.id)).toEqual([a.id, b.id, c.id])
      expect(otherPcs({ pcs: [], activeId: null })).toEqual([])
    })

    it('ids são únicos entre os PCs', () => {
      const ids = [upsertPc(A, 1), upsertPc(B, 2), upsertPc(C, 3)].map((r) => r.pc.id)
      expect(new Set(ids).size).toBe(3)
    })
  })

  describe('pcsStore (o que as telas leem)', () => {
    it('acompanha cada escrita', () => {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(A))
      loadPcs() // migra: tA ativo
      upsertPc(B, 200)
      expect(pcsStore.get()).toEqual(savedList())
      const [a, b] = pcsStore.get().pcs
      expect(pcsStore.get().activeId).toBe(a.id)

      setActivePc(b.id, 300)
      expect(pcsStore.get()).toEqual(savedList())
      expect(pcsStore.get().activeId).toBe(b.id)

      renamePc(a.id, 'Casa')
      expect(pcsStore.get().pcs[0].nome).toBe('Casa')
      namePcIfUnnamed('tB', 'Empresa-PC')
      saveLastConv('tB', 'c5')
      expect(pcsStore.get()).toEqual(savedList())
      expect(pcsStore.get().pcs[1]).toMatchObject({ nome: 'Empresa-PC', lastConv: 'c5' })

      removePc(b.id, 400)
      expect(pcsStore.get()).toEqual(savedList())
      expect(pcsStore.get().activeId).toBe(a.id)
      expect(pcsStore.get()).toEqual(loadPcs())
    })

    it('só notifica quando o conteúdo muda (sem re-render à toa)', () => {
      const a = upsertPc(A, 100).pc
      setActivePc(a.id, 110)
      const onChange = vi.fn()
      const off = pcsStore.subscribe(onChange)
      const before = pcsStore.get().pcs

      loadPcs()
      loadPcs()
      setActivePc(a.id, 110) // mesmo conteúdo
      renamePc(a.id, '   ') // inválido
      expect(onChange).not.toHaveBeenCalled()
      expect(pcsStore.get().pcs).toBe(before) // mesma referência: o useStore não re-renderiza

      renamePc(a.id, 'Casa')
      expect(onChange).toHaveBeenCalledTimes(1)
      renamePc(a.id, 'Casa')
      expect(onChange).toHaveBeenCalledTimes(1)
      off()
    })

    it('loadPcs volta a sincronizar o store com o que está no localStorage', () => {
      const a = upsertPc(A, 100).pc
      setActivePc(a.id, 110)
      localStorage.clear()
      loadPcs()
      expect(pcsStore.get()).toEqual({ pcs: [], activeId: null })
    })
  })
})
