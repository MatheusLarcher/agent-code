import { describe, expect, it } from 'vitest'
import { parseScrumVerdict } from './scrumVerdict'

describe('parseScrumVerdict — as linhas fixas do modelo', () => {
  it('lê JUSTIFICADO com a cobrança', () => {
    const v = parseScrumVerdict('JUSTIFICADO | a etapa foi subestimada\nCOBRANCA | Feche a etapa 3 agora.', 150)
    expect(v).toEqual({ veredito: 'justificado', tipoDesvio: null, motivo: 'a etapa foi subestimada', cobranca: 'Feche a etapa 3 agora.' })
  })

  it('lê DESVIO com o tipo conhecido', () => {
    const v = parseScrumVerdict('DESVIO | laco-de-teste | roda o typecheck em laço\nCOBRANCA | Mude a abordagem.', 200)
    expect(v).toMatchObject({ veredito: 'desvio', tipoDesvio: 'laco-de-teste', motivo: 'roda o typecheck em laço', cobranca: 'Mude a abordagem.' })
  })

  it('DESVIO com tipo desconhecido fica sem tipo e o texto vira o motivo', () => {
    const v = parseScrumVerdict('DESVIO | ficou lendo arquivos\nCOBRANCA | Volte.', 150)
    expect(v).toMatchObject({ veredito: 'desvio', tipoDesvio: null, motivo: 'ficou lendo arquivos' })
  })

  it('tolera acento e caixa no tipo e enfeite de markdown', () => {
    const v = parseScrumVerdict('- **DESVIO** | Laço-de-teste | x\n`COBRANÇA` | y', 150)
    expect(v).toMatchObject({ veredito: 'desvio', tipoDesvio: 'laco-de-teste', motivo: 'x', cobranca: 'y' })
  })

  it('PARAR vale no 300% e no travado', () => {
    expect(parseScrumVerdict('PARAR | laço sem saída\nCOBRANCA | z', 300).veredito).toBe('parar')
    expect(parseScrumVerdict('PARAR | laço sem saída\nCOBRANCA | z', 'travado').veredito).toBe('parar')
  })

  it('PARAR fora do 300% e do travado vira DESVIO', () => {
    expect(parseScrumVerdict('PARAR | laço\nCOBRANCA | z', 150)).toMatchObject({ veredito: 'desvio', tipoDesvio: null, motivo: 'laço' })
    expect(parseScrumVerdict('PARAR | laço\nCOBRANCA | z', 200).veredito).toBe('desvio')
  })

  it('linha fora do formato é ignorada e o primeiro veredito vale', () => {
    const text = 'Aqui vai minha análise:\nJUSTIFICADO | a\nDESVIO | reexplorando | b\nCOBRANCA | c\nCOBRANCA | d\nobrigado'
    expect(parseScrumVerdict(text, 300)).toEqual({ veredito: 'justificado', tipoDesvio: null, motivo: 'a', cobranca: 'c' })
  })

  it('sem veredito (vazio ou só prosa) é falha, mas guarda a cobrança se veio', () => {
    expect(parseScrumVerdict('', 150).veredito).toBe('falha')
    expect(parseScrumVerdict('acho que está tudo bem', 300)).toMatchObject({ veredito: 'falha', cobranca: null })
    expect(parseScrumVerdict('COBRANCA | feche', 150)).toMatchObject({ veredito: 'falha', cobranca: 'feche' })
  })

  it('sem linha COBRANCA, a cobrança fica nula', () => {
    expect(parseScrumVerdict('JUSTIFICADO | ok', 150).cobranca).toBeNull()
  })
})
