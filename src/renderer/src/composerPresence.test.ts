import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createComposerPresence, type ComposerPresenceStore } from './composerPresence'

/**
 * Fatos do composer por conversa (o que a máquina de reunião do escritório lê).
 * Relógio injetado: cada chamada recebe o instante (aqui, números fixos), então
 * os testes não esperam nem dependem do Date.now().
 */

let store: ComposerPresenceStore
let heard: string[]

beforeEach(() => {
  store = createComposerPresence()
  heard = []
  store.subscribe((convId) => heard.push(convId))
})

describe('composerPresence — rascunho', () => {
  it('texto liga draftActiveSince e mantém o início enquanto segue não vazio', () => {
    store.noteDraft('c1', 'o', 1000)
    expect(store.get('c1').draftActiveSince).toBe(1000)
    store.noteDraft('c1', 'oi', 1200)
    store.noteDraft('c1', 'oi, tudo', 1900)
    store.noteDraft('c1', 'oi', 2500)
    expect(store.get('c1').draftActiveSince).toBe(1000)
    expect(store.get('c1').lastInputAt).toBe(2500)
  })

  it('apagar tudo sem envio marca clearedAt e zera draftActiveSince', () => {
    store.noteDraft('c1', 'oi', 1000)
    store.noteDraft('c1', '', 3000)
    expect(store.get('c1')).toMatchObject({ draftActiveSince: null, clearedAt: 3000, sentAt: null })
  })

  it('noteSent seguido do esvaziamento NÃO marca clearedAt', () => {
    store.noteDraft('c1', 'mensagem', 1000)
    store.noteSent('c1', 2000)
    store.noteDraft('c1', '', 2000)
    expect(store.get('c1')).toMatchObject({ draftActiveSince: null, sentAt: 2000, clearedAt: null })
  })

  it('depois do envio, um rascunho novo começa de novo e apagá-lo conta', () => {
    store.noteDraft('c1', 'primeira', 1000)
    store.noteSent('c1', 2000)
    store.noteDraft('c1', '', 2000)
    store.noteDraft('c1', 's', 5000)
    expect(store.get('c1').draftActiveSince).toBe(5000)
    store.noteDraft('c1', '', 6000)
    expect(store.get('c1')).toMatchObject({ draftActiveSince: null, clearedAt: 6000, sentAt: 2000 })
  })

  it('só espaço em branco é vazio; anexo no texto (U+FFFC) é conteúdo', () => {
    store.noteDraft('c1', '  \n ', 1000)
    expect(store.get('c1').draftActiveSince).toBeNull()
    store.noteDraft('c1', '￼', 1100)
    expect(store.get('c1').draftActiveSince).toBe(1100)
    store.noteDraft('c1', ' ', 1200)
    expect(store.get('c1')).toMatchObject({ draftActiveSince: null, clearedAt: 1200 })
  })

  it('esvaziar o que nunca teve rascunho não é "apagou"', () => {
    store.noteDraft('c1', '', 1000)
    expect(store.get('c1').clearedAt).toBeNull()
    expect(heard).toEqual([])
  })
})

describe('composerPresence — microfone', () => {
  it('noteMic liga e desliga', () => {
    store.noteMic('c1', true, 1000)
    expect(store.get('c1')).toMatchObject({ micOn: true, lastInputAt: 1000 })
    store.noteMic('c1', false, 4000)
    expect(store.get('c1')).toMatchObject({ micOn: false, lastInputAt: 4000 })
    expect(heard).toEqual(['c1', 'c1'])
  })
})

describe('composerPresence — avisos', () => {
  it('avisa uma vez por mudança, com a conversa que mudou', () => {
    store.noteDraft('c1', 'o', 1000)
    store.noteMic('c2', true, 1100)
    store.noteSent('c1', 1200)
    store.noteDraft('c1', '', 1200)
    expect(heard).toEqual(['c1', 'c2', 'c1'])
  })

  it('nenhum aviso quando o estado não muda (mais teclas, mic repetido, envio repetido)', () => {
    store.noteDraft('c1', 'o', 1000)
    store.noteMic('c1', true, 1000)
    heard.length = 0
    store.noteDraft('c1', 'oi', 1100)
    store.noteDraft('c1', 'oi!', 1200)
    store.noteDraft('c1', 'oi!', 1200)
    store.noteMic('c1', true, 1300)
    expect(heard).toEqual([])
    store.noteSent('c1', 1400)
    store.noteSent('c1', 1400)
    store.noteDraft('c1', '', 1400)
    store.noteDraft('c1', '', 1500)
    expect(heard).toEqual(['c1'])
  })

  it('lastInputAt muda em silêncio e chega por get', () => {
    store.noteDraft('c1', 'o', 1000)
    heard.length = 0
    store.noteDraft('c1', 'oi', 1700)
    expect(heard).toEqual([])
    expect(store.get('c1').lastInputAt).toBe(1700)
  })

  it('conversas são independentes; desconhecida devolve o estado em repouso', () => {
    store.noteDraft('c1', 'oi', 1000)
    expect(store.get('c2')).toEqual({ draftActiveSince: null, lastInputAt: null, micOn: false, sentAt: null, clearedAt: null })
    expect(store.get('c1').draftActiveSince).toBe(1000)
  })

  it('cada estado é um objeto novo: quem guardou o anterior não o vê mudar', () => {
    store.noteDraft('c1', 'oi', 1000)
    const before = store.get('c1')
    store.noteDraft('c1', '', 2000)
    expect(before.draftActiveSince).toBe(1000)
    expect(store.get('c1')).not.toBe(before)
  })

  it('cancelar a inscrição para os avisos', () => {
    const cb = vi.fn()
    const off = store.subscribe(cb)
    store.noteDraft('c1', 'o', 1000)
    off()
    store.noteDraft('c1', '', 2000)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ouvinte que lança não impede os outros nem a publicação', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = createComposerPresence()
    const after = vi.fn()
    s.subscribe(() => {
      throw new Error('quebrado')
    })
    s.subscribe(after)
    expect(() => s.noteDraft('c1', 'oi', 1000)).not.toThrow()
    expect(after).toHaveBeenCalledWith('c1')
    expect(s.get('c1').draftActiveSince).toBe(1000)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
