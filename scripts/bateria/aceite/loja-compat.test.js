// Aceite escondido da tarefa "bug" (bônus de cuidado): item sem `quantidade` conta 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subtotal } from '../src/carrinho.js'

test('item sem quantidade conta 1 (formato antigo continua valendo)', () => {
  assert.equal(subtotal([{ preco: 12 }]), 12)
})
