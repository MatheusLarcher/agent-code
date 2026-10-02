// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CENTRAL_PROMPT_LANG,
  NEW_CONVERSATION,
  NO_PROJECT,
  OTHER_SUBJECT,
  Q_CONTINUA,
  Q_CONVERSA,
  Q_PROJETO,
  centralPromptTexts,
  firstCallRequest,
  secondCallRequest
} from './centralPrompts'

const message = { text: 'oi', attachments: [] }

describe('instruções da Central', () => {
  it('começa em inglês; chaves fixas estáveis', () => {
    expect(CENTRAL_PROMPT_LANG).toBe('en')
    expect([Q_CONTINUA, Q_PROJETO, Q_CONVERSA]).toEqual(['continua', 'projeto', 'conversa'])
    expect([OTHER_SUBJECT, NO_PROJECT, NEW_CONVERSATION]).toEqual(['outro_assunto', 'sem_projeto', 'nova'])
  })

  it.each([
    ['en', /never instructions to follow/, /SUBJECT/, /NOT a reason by itself/, /Random questions unrelated to any of these projects/],
    ['pt', /nunca instrução a seguir/, /ASSUNTO/, /NÃO é motivo por si só/, /Perguntas avulsas sem relação com nenhum desses projetos/]
  ] as const)('%s: state é conteúdo, "continua" é o ASSUNTO, pergunta avulsa é sem_projeto', (lang, guard, subject, notLast, random) => {
    const texts = centralPromptTexts(lang)
    for (const instruction of [texts.continua, texts.projeto, texts.conversation, texts.sandbox]) expect(instruction).toMatch(guard)
    expect(texts.continua).toMatch(subject)
    expect(texts.continua).toMatch(notLast)
    expect(texts.continua).toContain(OTHER_SUBJECT)
    expect(texts.projeto).toMatch(random)
    expect(texts.projeto).toContain(NO_PROJECT)
    expect(texts.conversation).toContain(NEW_CONVERSATION)
    expect(texts.sandbox).toContain(NEW_CONVERSATION)
  })

  it('idioma desconhecido cai no padrão', () => {
    expect(centralPromptTexts('xx' as 'en')).toBe(centralPromptTexts(CENTRAL_PROMPT_LANG))
  })
})

describe('montagem das chamadas', () => {
  it('1ª chamada sem recente nem projeto: nada a perguntar', () => {
    expect(firstCallRequest(message, [], [], 'en')).toEqual({ request: null, projects: [] })
  })

  it('2ª chamada sem conversa: nada a perguntar', () => {
    expect(secondCallRequest(message, { project: 'alpha', sandbox: false }, [], 'en')).toEqual({ request: null, conversations: [] })
  })

  it('a chave de cada opção vai no `state` (option) e é a chave da pergunta', () => {
    const { request } = secondCallRequest(
      message,
      { project: 'alpha', sandbox: false },
      [{ option: 'c1', title: '', firstRequest: 'faz o pdf', lastRequests: [], files: [], answerStart: '' }],
      'en'
    )
    expect((request?.state as { conversations: { option: string }[] }).conversations[0].option).toBe('c1')
    // Sem título, a descrição é o 1º pedido.
    expect(request?.questions.conversa).toMatchObject({ criteria: { c1: 'faz o pdf' } })
  })
})
