/**
 * Prova de campo do vigia: roda o prompt REAL contra o modelo real, em dois
 * casos opostos, e imprime o veredito já passado pelo parser.
 *
 * Existe porque teste unitário prova o parser, não a qualidade do prompt — e é
 * a qualidade do prompt que decide se o recurso vira aviso útil ou ruído.
 *
 * Bundlar com esbuild e rodar:
 *   npx esbuild scripts/vigia-probe.ts --bundle --platform=node --format=esm \
 *     --external:@anthropic-ai/claude-agent-sdk --outfile=out/vigia-probe.mjs
 *   node out/vigia-probe.mjs
 */
import { askVigia } from '../src/main/vigia/vigia'
import { buildVigiaPrompt, parseVigiaVerdict, type VigiaTurn } from '../src/main/vigia/vigiaPrompt'

const MODEL = 'claude-sonnet-5'

const CASES: Array<{ nome: string; esperado: 'ALERTA' | 'OK'; turn: VigiaTurn }> = [
  {
    nome: 'premissa que só o usuário sabe (medida real)',
    esperado: 'ALERTA',
    turn: {
      userText:
        'faz um suporte pra prender o eixo da extrusora da minha impressora, aquele do BMCU. ' +
        'quero que seja grosso e forte pra não quebrar.',
      calls: [
        { tool: 'Read', detail: 'src/params.py' },
        { tool: 'Edit', detail: 'src/params.py' },
        { tool: 'Bash', detail: 'python src/build.py' }
      ]
    }
  },
  {
    nome: 'pedido fechado, nada a perguntar',
    esperado: 'OK',
    turn: {
      userText: 'renomeia a função somaTotal para somarTotal em src/calc.ts e atualiza quem chama',
      calls: [
        { tool: 'Grep', detail: 'somaTotal' },
        { tool: 'Edit', detail: 'src/calc.ts' },
        { tool: 'Bash', detail: 'npm run typecheck' }
      ]
    }
  }
]

for (const caso of CASES) {
  const raw = await askVigia(buildVigiaPrompt(caso.turn), MODEL)
  const verdict = parseVigiaVerdict(raw)
  const got = verdict ? 'ALERTA' : 'OK'
  console.log(`\n[${got === caso.esperado ? 'OK ' : 'XX '}] ${caso.nome}`)
  console.log(`  esperado: ${caso.esperado}   obtido: ${got}`)
  console.log(`  cru: ${raw.replace(/\n/g, ' ⏎ ').slice(0, 300)}`)
  if (verdict) console.log(`  alerta: ${verdict}`)
}
