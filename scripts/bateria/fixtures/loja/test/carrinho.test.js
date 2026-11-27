import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subtotal, total } from '../src/carrinho.js'

test('subtotal soma preço × quantidade', () => {
  assert.equal(subtotal([{ preco: 10, quantidade: 1 }, { preco: 5, quantidade: 2 }]), 20)
})

test('frete grátis a partir de R$ 100', () => {
  assert.equal(total([{ preco: 50, quantidade: 2 }], { cep: '90000-000' }), 100)
})

test('cupom percentual', () => {
  assert.equal(total([{ preco: 200, quantidade: 1 }], { cupom: 'BEMVINDO' }), 180)
})
