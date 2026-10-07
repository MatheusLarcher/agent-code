/**
 * A FILA DO PROJETO: um plano por vez em cada pasta deste PC. O plano é o lote
 * de prompts de um "Enviar para implementação"; dentro dele, um prompt por vez
 * (a fila do quadro, handoffTracking.ts). A decisão mora no main
 * (handoffTracking/projectQueue*.ts); a tela só mostra a foto e manda as ações.
 *
 * "Projeto" é a PASTA neste PC, não o `projectId`: dois PCs com o mesmo
 * repositório clonado não disputam arquivo (card "Fila por pasta neste PC").
 */

/** O que o plano está fazendo agora. */
export type HandoffProjectPlanState =
  /** Nenhum prompt saiu ainda: espera a vez (ou a pasta limpa). */
  | 'na_fila'
  /** Um prompt do plano está rodando. */
  | 'rodando'
  /** O prompt anterior concluiu e o próximo vai sair. */
  | 'entre_prompts'
  /** Parou: pergunta ao usuário, erro depois das tentativas, prompt não concluído. */
  | 'parado'

/** As respostas em formato fixo do PO. */
export type HandoffProjectTurnVerdict = 'COMECAR' | 'ESPERAR'
export type HandoffProjectReplyVerdict = 'RETOMAR_A' | 'ESPERAR_B' | 'PERGUNTAR'

/** Uma avaliação do PO sobre a vez (o A parado há 30 min, ou a resposta guardada). */
export interface HandoffProjectEvaluation {
  id: string
  kind: 'vez' | 'resposta'
  at: string
  decisao: HandoffProjectTurnVerdict | HandoffProjectReplyVerdict
  motivo: string
  /** A pergunta curta ao usuário (só PERGUNTAR). */
  pergunta?: string
  /** A decisão veio da regra fixa (falha, prazo, formato errado), não do PO. */
  falhou: boolean
  /** Arquivos que o PO alterou durante a avaliação (git status antes × depois). */
  alterados: string[]
  /** A pasta do registro da avaliação (prompt, resposta, ferramentas usadas). */
  registro: string | null
  /** O plano parado (A) e o que esperava a vez (B). */
  loteA: string
  loteB: string
}

/** A resposta do usuário no A guardada enquanto outro plano tem a vez. */
export interface HandoffProjectReply {
  conversationId: string
  at: string
  /**
   * `decidindo`: o PO está decidindo; `retomar_a`: o A volta no fim do prompt
   * atual do B; `esperar_b`: o A espera o B inteiro; `pergunta`: o PO perguntou;
   * `agora`: o usuário mandou sair já ("Enviar agora mesmo assim").
   */
  estado: 'decidindo' | 'retomar_a' | 'esperar_b' | 'pergunta' | 'agora'
  motivo: string | null
  pergunta: string | null
  /** Quem decidiu o estado atual (`null` enquanto decide, ou sem decisão a tomar). */
  por?: 'po' | 'usuario' | null
}

export interface HandoffProjectPlan {
  loteId: string
  conversationId: string
  planTitulo: string
  /** 1 = a vez é dele. */
  posicao: number
  estado: HandoffProjectPlanState
  comecou: boolean
  /** "Começar mesmo assim" dado: pelo usuário ou pelo PO. */
  comecarMesmoAssim: 'usuario' | 'po' | null
  /** Arquivos que o plano anterior deixou sem commit, levados no 1º prompt (o PO começou com a pasta suja). */
  arquivosDoAnterior: string[]
  /** A pasta suja segura o começo deste plano: quantos arquivos sem commit (último git status). */
  sujo: number | null
  /** Minutos que faltam pela estimativa do plano (envios não concluídos); `null` sem estimativa. */
  restanteMin: number | null
}

export interface HandoffProjectFolder {
  /** projectFolderKey(cwd). */
  key: string
  cwd: string
  /** Na ordem da fila: o 1º tem a vez. Planos terminados saem. */
  plans: HandoffProjectPlan[]
  /** O plano com a vez começou e não terminou: as conversas avulsas da pasta mostram o aviso. */
  implantacaoEmCurso: boolean
  /** A avaliação mais recente do PO nesta pasta. */
  avaliacao: HandoffProjectEvaluation | null
  /** O PO está avaliando agora (a vez ou a resposta guardada). */
  avaliando: 'vez' | 'resposta' | null
  resposta: HandoffProjectReply | null
}

export interface HandoffProjectSnapshot {
  /** Pastas sem diferença de caixa (Windows): a chave vem em minúsculas. */
  caseInsensitive: boolean
  folders: HandoffProjectFolder[]
}

/** As ações do usuário na fila do projeto. */
export type HandoffProjectAction =
  /** "Começar mesmo assim": este plano começa agora, com a pasta suja ou o outro parado. */
  | 'comecar'
  /** "Passar a vez": o plano com a vez vai para trás do próximo. */
  | 'passar'
  /** Os botões da pergunta do PO, na conversa do A. */
  | 'retomar_a'
  | 'esperar_b'
  /** "Enviar agora mesmo assim": a resposta guardada sai já. */
  | 'enviar_agora'

/**
 * A pasta como chave da fila, igual nos dois processos: separadores iguais, sem
 * barra no fim e, no Windows, sem caixa. O main resolve o caminho antes.
 */
export function projectFolderKey(cwd: string, caseInsensitive: boolean): string {
  const key = cwd.trim().replace(/[\\/]+/g, '/').replace(/(?<=.)\/$/, '')
  return caseInsensitive ? key.toLowerCase() : key
}
