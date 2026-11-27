/** Frete: grátis a partir de R$ 100; senão R$ 15 (capital, CEP começando com 0) ou R$ 25. */
export function frete(valor, cep = '') {
  if (valor >= 100) return 0
  return String(cep).startsWith('0') ? 15 : 25
}
