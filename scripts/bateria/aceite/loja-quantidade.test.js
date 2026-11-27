// Aceite escondido da tarefa "bug": o agente não vê este arquivo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subtotal, total } from '../src/carrinho.js'

test('quantidade multiplica o preço', () => {
  assert.equal(subtotal([{ preco: 7.5, quantidade: 4 }]), 30)
})

test('total com quantidade, cupom e frete', () => {
  // 3 × 30 = 90 → BEMVINDO 10% = 81 → frete capital R$ 15 = 96
  assert.equal(total([{ preco: 30, quantidade: 3 }], { cep: '01001-000', cupom: 'BEMVINDO' }), 96)
})
