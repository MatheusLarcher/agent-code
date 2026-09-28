/**
 * "A caixa tem texto digitado?" — o aviso que o Composer dá a quem o hospeda
 * (`onHasTextChange`). O chat minimizado do Agent Manager usa para encolher a
 * caixa numa faixa de 1 linha, sem botões, quando não há rascunho de texto.
 *
 * Só TEXTO conta: cada anexo no meio do texto (imagem, arquivo) ocupa 1
 * caractere TOKEN no valor da caixa e não é rascunho — uma caixa só com uma
 * imagem continua "sem texto". Chips (elementos escolhidos no navegador) nem
 * passam pelo valor da caixa.
 *
 * O aviso sai só na TROCA vazio↔não vazio (não a cada tecla), inclusive quando
 * a troca vem de um rascunho restaurado ao mudar de conversa. Quem ouve parte
 * de "sem texto": montar vazio não avisa; montar com rascunho avisa `true`.
 * Trocar o ouvinte com texto na caixa avisa o novo (`true`) e devolve o antigo
 * a `false`; desmontar com texto também devolve o ouvinte a `false`.
 */
import { useEffect, useRef } from 'react'
import { TOKEN } from '../inlineMedia/editorModel'

export type HasTextListener = (hasText: boolean) => void

/** Há texto digitado? Os anexos no texto (1 TOKEN cada) não contam. */
export function hasTypedText(value: string): boolean {
  for (const ch of value) if (ch !== TOKEN) return true
  return false
}

export function useHasTextSignal(value: string, onChange: HasTextListener | undefined): void {
  const hasText = hasTypedText(value)
  // O último aviso dado, e a quem: o que o ouvinte atual acredita.
  const told = useRef<{ to: HasTextListener; hasText: boolean } | null>(null)

  useEffect(() => {
    const prev = told.current
    if (prev && prev.to !== onChange && prev.hasText) prev.to(false)
    if (!onChange) {
      told.current = null
      return
    }
    const believed = prev && prev.to === onChange ? prev.hasText : false
    told.current = { to: onChange, hasText }
    if (believed !== hasText) onChange(hasText)
  }, [hasText, onChange])

  // Ao desmontar, o ouvinte volta a "sem texto" e o registro zera junto: no
  // StrictMode o React desmonta e remonta os efeitos, e o 1º efeito, ao rodar
  // de novo, tem de saber que o ouvinte agora acredita em `false` e avisar de novo.
  useEffect(
    () => () => {
      const t = told.current
      told.current = null
      if (t?.hasText) t.to(false)
    },
    []
  )
}
