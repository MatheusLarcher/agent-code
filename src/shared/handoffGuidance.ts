import type { HandoffConfig } from './ipc'

/**
 * O que os interruptores do handoff (AppConfig.handoff) acrescentam ao pedido de
 * handoff ao Agent Manager (renderer, handoffFlow.ts) e à seção ### Handoff do
 * prompt dele (main, planningPrompt.ts) — o MESMO texto nos dois lugares. Com o
 * interruptor desligado, nada daqui entra e os dois textos ficam como antes.
 */

/** Ausente = desligado: quem não informa os interruptores recebe o texto de antes. */
export type HandoffGuidance = Partial<HandoffConfig>

/**
 * Ciclo por etapa, com a skill de cada fase. No Quadro, UM item por etapa e a
 * fase no activeForm: `cardForEtapa` (main/handoffTracking/handoffCardMatch.ts)
 * escolhe um cartão por etapa e prefere os concluídos — um cartão por fase com o
 * mesmo prefixo fecharia a etapa no primeiro concluído.
 */
export const HANDOFF_CYCLE_RULE =
  'Ciclo obrigatório: cada prompt manda a implementação trabalhar CADA etapa nestas 7 fases, nesta ordem, com a skill de cada uma:\n' +
  '1. plan — declarar a etapa no plano e ler em lote os arquivos dela (skill executing-plans; subagent-driven-development se delegar);\n' +
  '2. test — antes de mexer em lógica, escrever o teste que falha e mostrar a falha (RED) (skill test-driven-development, ou tdd-workflow se instalada); ' +
  'mudança só visual ou de texto: escrever antes o roteiro de verificação no app (o que abrir, clicar e ver);\n' +
  '3. implement — o mínimo para passar; refatorar com o teste verde;\n' +
  '4. review — revisar o diff da etapa (skill code-review ou requesting-code-review); bug achado é corrigido e revisado de novo; ' +
  'o que decidir não corrigir vai no relatório, com o motivo;\n' +
  '5. verify — typecheck, testes, build e o app rodando de verdade (skills verification-before-completion e verification-loop); ' +
  'teste pulado ou falha atribuída a "bug que já existia" é declarado no relatório, com o motivo;\n' +
  '6. remember — aprendizado não óbvio (armadilha, regra do projeto) vira memória por memory_propose; nada que já esteja no código ou no git;\n' +
  '7. improve — no fim do prompt, autoavaliação 1–5 em precisão, completude, clareza, ação e concisão, com prova (skill agent-self-evaluation), ' +
  'e uma lista "Melhorias sugeridas" — só sugerir, sem editar skill nem prompt.\n' +
  'Proporcional: etapa trivial (texto, configuração) pode juntar test e verify, dizendo por quê. ' +
  'O relatório final traz o mapa etapa → teste → prova RED → prova GREEN. ' +
  'No Quadro (TodoWrite/TaskCreate): um item por etapa, com o título [id-da-etapa] …, e a fase atual no texto de andamento (activeForm), ' +
  'ex.: "[id-da-etapa] test: escrevendo o teste que falha" — nunca um item por fase com o mesmo prefixo: o primeiro concluído fecharia a etapa antes da hora.'

/**
 * Leitura guiada: a lista de arquivos pronta no topo de cada prompt. Sem ela, a
 * implementação lia um arquivo por vez antes do 1º Edit (medido: 43 chamadas e
 * 55 Read num handoff com ~15 âncoras arquivo:linha soltas no texto). Com a lista
 * pronta as leituras ficam independentes e saem em paralelo. Não injeta o
 * conteúdo dos arquivos: o Edit exige que o agente tenha lido com Read.
 */
export const HANDOFF_FILES_RULE =
  'Seção Arquivos: no TOPO de cada prompt, antes de tudo, uma seção "Arquivos" com duas listas: ' +
  '"Ler antes de começar" — caminho relativo à raiz do projeto, com :linha quando houver, e uma linha dizendo o que tem ali; ' +
  'e "Editar/criar" — caminho e o que muda em cada um. Só arquivos que você conferiu no código durante o planejamento (Read/Grep), nunca palpite; ' +
  'cada prompt lista só os arquivos das etapas dele. E cada prompt exige da implementação: ' +
  '"Abra TODOS os arquivos de \'Ler antes de começar\' numa única resposta, com as leituras em paralelo. ' +
  'Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento." ' +
  'O pedido de consultar a pasta do plano continua, como consulta pontual.'

/** Os blocos que os interruptores ligados acrescentam, na ordem em que entram:
 *  a seção Arquivos (que vai no topo do prompt) antes do ciclo. */
export function handoffGuidanceRules(guidance: HandoffGuidance = {}): string[] {
  return [...(guidance.leituraGuiada ? [HANDOFF_FILES_RULE] : []), ...(guidance.ciclo ? [HANDOFF_CYCLE_RULE] : [])]
}
