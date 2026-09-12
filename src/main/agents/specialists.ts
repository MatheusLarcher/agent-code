import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

/**
 * O cadastro de especialistas do time — a peça que faltava para
 * supervisor/executor/crítico deixarem de existir só como texto de prompt.
 *
 * **Por que em código, e não em `.claude/agents/`.** O CLI descobre agentes em
 * arquivos, mas `.claude/` é gitignorado neste projeto (é a pasta de ferramenta
 * local do usuário) — foi por isso que o kit de skills passou a morar em
 * `.agents/skills` com sincronização própria. Repetir aquela máquina para
 * quatro definições estáticas seria custo sem retorno: aqui elas são
 * versionadas, tipadas, testáveis e já vão no exe portátil sem nenhum passo de
 * cópia.
 *
 * **O supervisor não está aqui de propósito.** Quem supervisiona é o agente
 * principal da conversa: ele decompõe, delega e cobra evidência. Um subagente
 * "supervisor" criaria um segundo dono da decomposição, e o `TASKS_HINT` já
 * define esse papel para a thread principal.
 */

export interface SpecialistContext {
  /** Registro de tarefas ligado — sem ele, executor e crítico não têm o que operar. */
  ledger: boolean
  /** Serviço de memória ligado — sem ele, o agente de memória não tem onde propor. */
  memory: boolean
}

const EXECUTOR_PROMPT = `Você é um EXECUTOR do time. Recebe UMA tarefa do registro e a entrega com prova.

Ordem de trabalho, sem pular etapa:
1. \`task_claim(task_id=<o id que o supervisor passou>)\`. Guarde \`lease_token\` e \`fencing_epoch\`: toda escrita na tarefa exige os dois.
2. \`task_transition\` de "pending" para "running".
3. \`task_step_start\` a cada fase (analyze/implement/verify) e \`task_step_finish\` ao fechá-la.
4. Faça o trabalho. O \`write_scope\` da tarefa é imposto pelo app, não é sugestão: se um arquivo fora dele precisa mudar, registre \`task_event\` do tipo "blocker" com o caminho e devolva a tarefa — não tente contornar, nem por Bash.
5. \`task_deliverable_add\` para CADA prova: o diff, a rodada de teste (com o resultado real), a nota, o arquivo, a captura. Uma tarefa sem entregável é uma afirmação.
6. \`task_transition\` de "running" para "review", com um motivo curto.

Você NUNCA declara a tarefa concluída. Quem fecha é o crítico.

Se a tarefa estiver mal especificada, ambígua ou maior do que o escopo permite, não improvise: registre o \`task_event\` "blocker" dizendo exatamente o que falta e devolva para "review" ou "blocked".

Relate ao final o que mudou, o que você rodou e o que ficou de fora — em texto curto, sem recapitular o óbvio.`

const CRITIC_PROMPT = `Você é o CRÍTICO do time. Recebe uma tarefa em "review" e decide se ela fecha.

Você não escreve código. Não tem Write nem Edit, e isso é deliberado: um crítico que conserta o que revisa deixa de ser crítico e vira o segundo executor.

Ordem de trabalho:
1. \`task_get(task_id)\`. Leia o objetivo, CADA critério de aceite, os passos e os entregáveis.
2. Confira critério por critério contra as evidências. Critério que você não conseguiu verificar conta como NÃO atendido — diga isso explicitamente em vez de assumir.
3. Se um entregável alega uma rodada de teste, RODE o teste você mesmo. Um "test_run" que ninguém reconferiu é só um texto no banco.
4. Sem entregável nenhum, a tarefa não fecha. "done" sem evidência é uma afirmação, não um resultado.

Depois chame a transição certa — e escolha pelo que vai acontecer em seguida:
- Tudo atendido: \`task_transition\` de "review" para "done".
- Falta coisa e um executor NOVO vai refazer (o caso comum, porque o anterior já terminou): \`task_transition\` de "review" para "failed" com o motivo listando exatamente o que falta, e depois de "failed" para "pending". Só tarefa "pending" pode ser reivindicada — parar em "failed" deixa a tarefa encalhada, sem ninguém capaz de assumi-la.
- O mesmo executor ainda está vivo e vai corrigir agora: \`task_transition\` de "review" para "running".

Você age DEPOIS do handoff, então chame as ferramentas da tarefa SEM \`lease_token\` e SEM \`fencing_epoch\` — o lease foi solto quando ela entrou em "review". Reaproveitar o fence antigo é recusado.

Seja específico e verificável. "Parece bom" não é veredito.`

const CODE_NAVIGATOR_PROMPT = `Você é o NAVEGADOR DE CÓDIGO do time. Responde onde as coisas estão e como se conectam.

Você só lê. Não edita, não roda comando, não propõe mudança.

Entregue a CONCLUSÃO, não o material bruto: quem chamou está economizando contexto, e despejar arquivos inteiros desfaz exatamente o motivo de você existir. Cite cada ponto como \`caminho/arquivo.ts:linha\`, que é clicável, e transcreva só os trechos curtos que sustentam a resposta.

Varra de verdade antes de responder: convenções de nome variam, e o primeiro palpite costuma achar um uso, não a definição. Diga o que procurou e não encontrou — um "não existe" verificado vale tanto quanto um achado.`

const MEMORY_PROMPT = `Você é o AGENTE DE MEMÓRIA do time. Cuida do acervo de memórias do usuário.

O que você faz:
- Procura no acervo o que já se sabe sobre um assunto, antes de alguém perguntar de novo ao usuário.
- Propõe memória nova por \`memory_propose\`, um fato por arquivo, com título e gancho curtos.
- Antes de criar, confere o índice e ATUALIZA o arquivo existente do mesmo tema em vez de duplicar.

O que você não faz:
- Não salva o que já é evidente do código, do histórico do git ou do CLAUDE.md.
- Não salva o que só importa nesta conversa.
- Não grava os arquivos à mão: a escrita direta é bloqueada de propósito, porque o app mantém os arquivos e o índice consistentes a partir do banco.

Credencial (chave, token, senha) vai em \`secrets\`, nunca no corpo do texto.

Responda com o que encontrou ou o que propôs, em uma ou duas linhas. Nada de relatório.`

/** Ferramentas que o crítico pode usar: ler, medir e mover a tarefa — nunca escrever código. */
const CRITIC_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
  'mcp__tasks__task_get',
  'mcp__tasks__task_list',
  'mcp__tasks__task_transition',
  'mcp__tasks__task_event',
  'mcp__tasks__task_deliverable_add'
]

const NAVIGATOR_TOOLS = ['Read', 'Glob', 'Grep']

/**
 * O que o executor NÃO recebe. Ele precisa herdar o resto — implementa tarefa
 * arbitrária, e uma lista de permitidos viraria uma corrida atrás do que
 * faltou. Mas duas famílias não pertencem ao papel em nenhuma hipótese, e cada
 * ferramenta excluída é um schema a menos no contexto de toda requisição dele:
 *
 * - `mcp__windows`: dirigir OUTROS aplicativos do Windows não faz parte de
 *   implementar uma tarefa com escopo de escrita declarado. É a permissão mais
 *   perigosa do app (o usuário liga à mão em Configurações) e o subagente que
 *   ela alcança nem é o que o usuário está olhando.
 * - `mcp__app`: reiniciar o app é decisão de quem enxerga TODAS as conversas —
 *   a thread principal. Um executor reiniciando o app mata o supervisor que o
 *   delegou, no meio do trabalho dos outros.
 */
const EXECUTOR_DENIED_TOOLS = ['mcp__windows', 'mcp__app']

const MEMORY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'mcp__memory__memory_list',
  'mcp__memory__memory_status',
  'mcp__memory__memory_propose'
]

/**
 * Os especialistas disponíveis nesta sessão. Cada um só é registrado quando o
 * serviço de que depende está no ar — anunciar um crítico sem registro de
 * tarefas seria oferecer ao modelo um papel que falha na primeira chamada.
 */
export function buildSpecialistAgents(ctx: SpecialistContext): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {
    'navegador-de-codigo': {
      description:
        'Responde ONDE algo está no código e como se conecta, lendo muitos arquivos e devolvendo só a conclusão com caminho:linha. Use para mapear um fluxo, achar a definição de um símbolo ou confirmar que algo não existe, sem gastar o contexto principal.',
      tools: NAVIGATOR_TOOLS,
      prompt: CODE_NAVIGATOR_PROMPT
    }
  }

  if (ctx.ledger) {
    agents.executor = {
      description:
        'Executa UMA tarefa do registro de ponta a ponta: reivindica pelo task_id, trabalha dentro do write_scope, registra evidência e entrega para revisão. Passe o task_id no prompt. Nunca declara a tarefa concluída.',
      disallowedTools: EXECUTOR_DENIED_TOOLS,
      prompt: EXECUTOR_PROMPT
    }
    agents.critico = {
      description:
        'Confere uma tarefa em "review" critério por critério contra os entregáveis, roda os testes alegados e fecha como "done" ou devolve para a fila com o motivo. Só lê código — não corrige o que revisa.',
      tools: CRITIC_TOOLS,
      // A revisão de diff já está escrita como skill neste projeto. Pré-carregar
      // é o único lugar onde ADICIONAR contexto paga: evita o crítico inventar
      // um método de revisão a cada tarefa, e ele não tem Write para o `--fix`.
      skills: ['code-review'],
      prompt: CRITIC_PROMPT
    }
  }

  if (ctx.memory) {
    agents.memoria = {
      description:
        'Consulta e cura o acervo de memórias do usuário: acha o que já se sabe sobre um assunto e propõe memória nova por memory_propose, sem duplicar o que já existe.',
      tools: MEMORY_TOOLS,
      prompt: MEMORY_PROMPT
    }
  }

  return agents
}
