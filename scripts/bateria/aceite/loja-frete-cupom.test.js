// Aceite escondido da tarefa "feature-cupom": copiado para o projeto só na hora de conferir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/carrinho.js'

const CEP = '01001-000' // capital: frete R$ 15 abaixo de R$ 100

test('FRETEGRATIS zera o frete', () => {
  assert.equal(total([{ preco: 60 }], { cep: CEP, cupom: 'FRETEGRATIS' }), 60)
})

test('FRETE50: metade do frete a partir de R$ 50', () => {
  assert.equal(total([{ preco: 60 }], { cep: CEP, cupom: 'FRETE50' }), 67.5)
  assert.equal(total([{ preco: 40 }], { cep: CEP, cupom: 'FRETE50' }), 55)
})

test('o resto continua igual', () => {
  assert.equal(total([{ preco: 60 }], { cep: CEP }), 75)
  assert.equal(total([{ preco: 200 }], { cep: CEP, cupom: 'BEMVINDO' }), 180)
  assert.equal(total([{ preco: 50 }], { cep: '90000-000', cupom: 'FIXO20' }), 55)
})
