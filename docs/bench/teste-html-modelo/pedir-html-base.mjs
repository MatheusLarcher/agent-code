import { request } from 'node:http'
import { writeFileSync } from 'node:fs'

const PEDIDO = `Gere uma página HTML completa e autocontida (um único arquivo .html, com CSS embutido em <style>, sem dependências externas) de um dashboard simples de "vendas do mês": um cabeçalho com o título, 3 cards de KPI (total vendido, número de pedidos, ticket médio) com números de exemplo, e uma tabela com 5 linhas de produtos mais vendidos (nome, quantidade, valor). Use um visual moderno, cores agradáveis, cantos arredondados e sombra leve nos cards.`

const t0 = Date.now()
const corpo = JSON.stringify({
  model: 'qwen3-5-0-8b-base-html',
  messages: [
    { role: 'system', content: 'Você é um engenheiro sênior de front-end. Responda APENAS com o código HTML completo, dentro de um bloco de código, sem nenhum texto fora dele.' },
    { role: 'user', content: PEDIDO }
  ],
  stream: true,
  options: { temperature: 0, num_ctx: 8192, num_predict: 4000 }
})

const req = request(
  { hostname: '127.0.0.1', port: 11537, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) } },
  (res) => {
    let texto = ''
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      const linhas = buffer.split('\n')
      buffer = linhas.pop() ?? ''
      for (const linha of linhas) {
        if (!linha.trim()) continue
        try {
          const row = JSON.parse(linha)
          if (row.message?.content) texto += row.message.content
        } catch {}
      }
    })
    res.on('end', () => {
      const segundos = (Date.now() - t0) / 1000
      writeFileSync('docs/bench/teste-html-modelo/resposta-base-crua.txt', texto, 'utf8')
      const m = texto.match(/```[a-z]*\n([\s\S]*?)```/)
      const html = (m ? m[1] : texto).trim()
      writeFileSync('docs/bench/teste-html-modelo/modelo-08b-base.html', html, 'utf8')
      writeFileSync('docs/bench/teste-html-modelo/tempo-base.json', JSON.stringify({ segundos, chars: html.length }, null, 2))
      console.log(`tempo: ${segundos.toFixed(1)}s, ${html.length} chars`)
    })
  }
)
req.on('error', (e) => {
  console.error('ERRO', e)
  process.exitCode = 1
})
req.end(corpo)
