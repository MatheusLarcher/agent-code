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

/** Os blocos que os interruptores ligados acrescentam (hoje, só a seção Arquivos,
 *  que vai no topo do prompt). O rigor por etapa vem do formato Aceite/Verificar
 *  com/Decidido (handoffWorkRules.ts), decidido no planejamento. */
export function handoffGuidanceRules(guidance: HandoffGuidance = {}): string[] {
  return guidance.leituraGuiada ? [HANDOFF_FILES_RULE] : []
}
