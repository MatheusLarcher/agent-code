const CUPONS = {
  BEMVINDO: { tipo: 'percentual', valor: 10 },
  FIXO20: { tipo: 'fixo', valor: 20 },
  FRETEGRATIS: { tipo: 'frete', valor: 0 }
}

/** Aplica um cupom ao subtotal. Cupom desconhecido não muda nada. */
export function aplicarCupom(subtotal, codigo) {
  const cupom = CUPONS[String(codigo).toUpperCase()]
  if (!cupom) return subtotal
  if (cupom.tipo === 'percentual') return subtotal * (1 - cupom.valor / 100)
  if (cupom.tipo === 'fixo') return subtotal - cupom.valor
  return subtotal
}
