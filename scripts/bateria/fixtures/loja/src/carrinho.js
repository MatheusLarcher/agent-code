import { frete } from './frete.js'
import { aplicarCupom } from './desconto.js'

/** Soma dos itens: cada item tem `preco` (em reais) e `quantidade`. */
export function subtotal(itens) {
  return itens.reduce((soma, item) => soma + item.preco, 0)
}

/** Total a pagar: subtotal com cupom (se houver) mais o frete. */
export function total(itens, { cep, cupom } = {}) {
  const comDesconto = cupom ? aplicarCupom(subtotal(itens), cupom) : subtotal(itens)
  return Math.round((comDesconto + frete(comDesconto, cep)) * 100) / 100
}
