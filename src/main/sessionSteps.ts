/**
 * Prazos POR PASSO das operações que trocam a sessão de uma conversa (agent:start
 * e a troca do agent:send). Elas rodam dentro do lock da conversa
 * (conversationLock.ts), que NÃO tem prazo: uma operação só sai dele quando
 * termina de verdade. O que impede a conversa de ficar presa é cada passo que
 * pode travar ter o próprio prazo e falhar sozinho — e a operação, ao falhar,
 * desfazer o que criou antes de sair do lock.
 *
 * Um passo que estourou não é cancelável (a consulta ao banco continua no
 * servidor). Por isso o `run` guarda o trabalho atrasado por chave (conversa +
 * passo): quando ele chegar, `undo` desfaz o que ele criou (ex.: solta o lease
 * que chegou tarde), e o PRÓXIMO passo com a mesma chave espera o atrasado
 * assentar antes de começar (contando no próprio prazo). Assim duas aquisições
 * de lease — ou duas importações do transcript — da mesma conversa nunca correm
 * juntas no banco.
 */

/**
 * Aquisição do lease: 35 s. É uma transação só (SELECT … FOR UPDATE + UPSERT,
 * postgresRepository.ts `acquireConversationLease`). Pior caso legítimo:
 * vaga/handshake do pool 8 s (POSTGRES_CONNECT_TIMEOUT_MS) + SET da sessão 10 s
 * (SESSION_SETUP_TIMEOUT_MS) + espera pela trava da linha 15 s (lock_timeout,
 * POSTGRES_LOCK_TIMEOUT_MS — depois disso o próprio Postgres devolve 55P03) +
 * dois comandos de milissegundos = 33 s. Passou de 35 s, a conexão travou (só o
 * query_timeout de 130 s a soltaria): o passo falha.
 */
export const LEASE_ACQUIRE_DEADLINE_MS = 35_000

/**
 * Soltar o lease anterior: 20 s, e o passo NÃO falha a operação ao estourar —
 * a soltura é cercada por token+epoch (uma soltura atrasada não mexe no lease
 * novo) e, se não chegar, o lease vence sozinho em 60 s. Pior caso legítimo:
 * espera por uma renovação em voo 1 s (LEASE_RELEASE_WAIT_MS) + vaga e SET do
 * pool 18 s + um UPDATE de milissegundos = 19 s.
 */
export const LEASE_RELEASE_DEADLINE_MS = 20_000

/**
 * Preparar a retomada (`prepareSessionResume`: conferir `resume_ready`,
 * importar o transcript local para o banco, reler e marcar pronto): 90 s no
 * TOTAL. Pior caso legítimo: um append do espelho no teto inteiro de
 * tentativas, 45 s (MIRROR_APPEND_RETRY_BUDGET_MS), + vaga e SET do pool
 * (18 s) para a consulta de `resume_ready` e de novo para a marcação final
 * (2 × 18 s = 36 s) + leituras de milissegundos = 81 s. Estourou: a subida
 * falha com erro claro (sem retomar em silêncio); a importação atrasada segue e
 * a próxima tentativa espera por ela — e costuma achar a retomada já pronta.
 */
export const RESUME_PREPARE_DEADLINE_MS = 90_000

/** TypeSafe do Agent Manager (o maior dos dois TypeSafe da subida; o do
 *  Automático da conversa é de 3 s e nunca roda junto): TYPESAFE_TIMEOUT_MS. */
export const START_TYPESAFE_CEILING_MS = 8_000
/** `resolveSessionAccount` com contas extras: `claude auth status` com
 *  `timeout: 15_000` (auth.ts). */
export const START_ACCOUNT_CEILING_MS = 15_000

/**
 * Quanto tempo, no máximo, uma operação segura o lock da conversa — a soma dos
 * prazos reais do caminho mais longo do agent:start (o da troca do agent:send é
 * mais curto: não solta o lease anterior):
 * TypeSafe 8 s + conta 15 s + soltar o lease anterior 20 s + adquirir 35 s +
 * preparar a retomada 90 s + soltar o lease adquirido na falha 20 s = 188 s.
 * `AgentSession.start()` não entra: ele não espera o CLI responder (cria o
 * `query()` e devolve), só lê disco local e sobe o proxy local do Codex.
 * Isto é um TETO, não um prazo: nada no lock é abandonado; cada passo acima
 * falha sozinho ao estourar.
 */
export const SESSION_OPERATION_CEILING_MS =
  START_TYPESAFE_CEILING_MS +
  START_ACCOUNT_CEILING_MS +
  LEASE_RELEASE_DEADLINE_MS +
  LEASE_ACQUIRE_DEADLINE_MS +
  RESUME_PREPARE_DEADLINE_MS +
  LEASE_RELEASE_DEADLINE_MS

export class StepDeadlineError extends Error {
  constructor(
    readonly step: string,
    readonly deadlineMs: number
  ) {
    super(`${step} não terminou em ${Math.round(deadlineMs / 1000)} s; a operação foi desfeita. Tente de novo.`)
    this.name = 'StepDeadlineError'
  }
}

export interface StepRunner {
  /**
   * Roda `start()` com prazo. Terminou antes: devolve o valor (ou a falha).
   * Estourou: rejeita com `StepDeadlineError`; o valor que chegar depois vai
   * para `undo`. `key` agrupa os passos que não podem correr juntos (conversa +
   * passo): um novo espera o atrasado anterior, dentro do próprio prazo.
   */
  run<T>(key: string, step: string, deadlineMs: number, start: () => Promise<T>, undo?: (late: T) => unknown): Promise<T>
  /** Há trabalho atrasado desta chave ainda sem assentar? (diagnóstico/testes) */
  pending(key: string): boolean
}

export function createStepRunner(): StepRunner {
  const late = new Map<string, Promise<void>>()

  return {
    pending: (key) => late.has(key),
    async run<T>(key: string, step: string, deadlineMs: number, start: () => Promise<T>, undo?: (late: T) => unknown): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), deadlineMs)
      })
      try {
        const previous = late.get(key)
        if (previous && (await Promise.race([previous.then(() => 'settled' as const), expired])) === 'expired') {
          throw new StepDeadlineError(step, deadlineMs)
        }
        const work = start()
        const outcome = await Promise.race([work.then((value) => ({ value })), expired])
        if (outcome !== 'expired') return outcome.value
        // Atrasado: segue rastreado até assentar; o que ele criar é desfeito.
        const tail: Promise<void> = work
          .then(async (value) => {
            await undo?.(value)
          })
          .catch(() => undefined)
          .finally(() => {
            if (late.get(key) === tail) late.delete(key)
          })
        late.set(key, tail)
        throw new StepDeadlineError(step, deadlineMs)
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
