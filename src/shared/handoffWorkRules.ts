/**
 * As regras de trabalho da conversa de handoff, num lugar só: o bloco do
 * system prompt (main/planning/planningSession.ts), o rascunho automático do
 * prompt (renderer/planning/handoffReadiness.ts) e os dois textos do Agent
 * Manager (main/planning/planningPrompt.ts e renderer/planning/handoffFlow.ts)
 * usam o MESMO texto.
 */

/** Autonomia: decide pelos cards, desvia pelo mínimo, nunca termina perguntando. */
export const HANDOFF_DECIDE_RULE =
  "Dúvida de interpretação: procure a resposta nos cards (decisão, requisito, ambiguidade resolvida, 'Decidido:' do prompt). Achou, siga. Não achou, escolha a leitura mais conservadora (menor escopo, reversível), registre em 'Decisões tomadas sozinho' no relatório final e siga. Se o código real contradisser o plano, desvie pelo mínimo necessário, marque a etapa com 'DESVIO DO PLANO: …' e continue. Nunca termine o turno com pergunta: termine com entrega ou com bloqueio real explicado. Pergunte (AskUserQuestion) só para ação destrutiva."

/** Avaliação contínua: o senso crítico durante a implementação — avisa, não para. (a)–(e). */
export const HANDOFF_CONTINUOUS_RULES: readonly string[] = [
  'Antes de cada etapa, rode `git status --short` e `git diff --stat` dos arquivos que ela vai tocar, compare com a seção Arquivos do prompt e leia o bloco OUTRAS_CONVERSAS. Se outra conversa mexeu num arquivo seu, se o código mudou desde o planejamento (linha não bate, símbolo sumiu) ou se uma premissa do card não vale mais, escreva no chat uma linha que começa com "ATENÇÃO: " dizendo o que mudou e o que vai fazer — sem reverter nada de ninguém —, adapte e siga.',
  'Decisão do plano contradita pela evidência: escreva uma linha que começa com "DESVIO DO PLANO: " com o que encontrou e o que fez, e siga.',
  'Ao fechar cada etapa, um autocheck de 3 linhas, texto livre (sem nota): "Pode quebrar: …", "Não testei: …", "Olhe isto: …".',
  'O relatório final tem a seção "Atenções", com todas as linhas ATENÇÃO e DESVIO DO PLANO.',
  'Nada disso é pergunta: avise e siga.'
]

/**
 * Ferramentas: o que custou tempo ativo na medição (suíte completa repetida
 * dezenas de vezes, polling de 10 min em série, empacotamento 2×). É
 * instrução, não bloqueio: recusar o comando faria o agente contornar.
 */
export const HANDOFF_TOOLING_RULES: readonly string[] = [
  'Testes durante a etapa: só os arquivos que ela tocou e os testes deles (`npx vitest run <arquivos>`) e o typecheck do tsconfig afetado (ex.: `npx tsc -p tsconfig.node.json --noEmit`, ou o web/phone).',
  'Suíte completa e `npm run typecheck` UMA vez, no fechamento do envio — é o que a revisão final confere.',
  'Esperar serviço, log ou build longo: rode em segundo plano (`run_in_background`) e siga trabalhando; nunca um laço com `sleep` dentro do turno.',
  'Empacotamento e instalador (`npm run package:portable`, `build-installer.bat`) só quando o plano pede o artefato, e uma vez.'
]

/**
 * Contexto: a conversa de handoff compacta depois de 200k, ao fechar uma etapa
 * (stageCompaction.ts) — ou no meio dela, se o contexto chega ao teto. O mapa e
 * o resumo da etapa no chat sobrevivem à compactação; reler resultado antigo de
 * ferramenta só infla o contexto.
 */
export const HANDOFF_STAGE_SUMMARY_RULE =
  'Depois de ler o código de uma etapa e antes de mudar qualquer arquivo, escreva no chat o mapa curto dela (caminho:linha, o que há lá e as decisões que você tirou). Ao fechar cada item do roteiro no TodoWrite/TaskCreate, escreva no chat um resumo de 5 linhas da etapa (o que mudou, onde, a prova, o que ficou de fora, o próximo passo) e, logo depois, o autocheck de 3 linhas; o mapa e o resumo são o que sobrevive à compactação. Não releia resultados antigos de ferramenta: confie no resumo, no mapa da etapa e no mapa do prompt.'

/** O formato de cada etapa no prompt de handoff (o plan_handoff_write confere "Aceite:" e "Verificar com:"). */
export const HANDOFF_STAGE_FORMAT_RULE =
  'Formato de cada etapa no prompt: uma seção com o id da etapa entre colchetes no título (ex.: "### 1. [pagamento] Integrar o checkout") e, dentro dela, três linhas: "Aceite:" (o que prova que a etapa está pronta, verificável), "Verificar com:" (o comando, teste ou arquivo que prova) e "Decidido:" (as respostas às dúvidas que a implementação provavelmente terá, tiradas dos cards). Sem "Aceite:" e "Verificar com:" em cada etapa, o plan_handoff_write recusa.'

/** A autonomia da conversa de handoff, decidida no planejamento (card lido pelo app). */
export const HANDOFF_AUTONOMY_CARD_RULE =
  'Grave o card `decisao-autonomia-handoff` (Perguntas: nenhuma | só o que listar | como hoje; Permissões: permitir tudo, exceto destrutivo | pedir como hoje). Pergunte ao usuário só quando o projeto tem risco (produção, dados reais, deploy, dinheiro, integração externa); projeto simples: grave o padrão autônomo sem perguntar. O prompt gerado traz o card quando existir.'

/** Como o Manager pede a avaliação contínua em cada prompt. */
export function handoffContinuousRequirement(): string {
  return `Cada prompt também exige da implementação a avaliação contínua (avisa, não para): ${HANDOFF_CONTINUOUS_RULES.map((rule, i) => `(${String.fromCharCode(97 + i)}) ${rule}`).join(' ')}`
}
