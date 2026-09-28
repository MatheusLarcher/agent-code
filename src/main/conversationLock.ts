/**
 * Fila por conversa para o que troca a sessão dela: todo `agent:start`, a troca
 * de sessão do `agent:send` (tarefa MCP que pede outro modelo) e a aquisição do
 * lease da troca de conta entram aqui, um de cada vez por conversa. Sem isto, um
 * start que descarta a sessão viva e só instala a dele depois dos `await` de
 * lease podia se cruzar com a troca e deixar duas sessões vivas (uma fora do
 * mapa, sem dispose).
 *
 * Conversas diferentes não esperam umas pelas outras. Uma falha libera a vez do
 * próximo normalmente (quem chamou recebe a falha).
 *
 * SEM PRAZO, de propósito: uma operação só sai da fila quando termina de verdade
 * (o `finally` da promessa dela). Um prazo aqui que passasse a vez com a operação
 * ainda rodando deixava duas operações vivas na mesma conversa — a abandonada
 * seguia mexendo no mapa de sessões e no lease da seguinte. O que impede a
 * conversa de ficar presa é cada passo que pode travar DENTRO da operação ter o
 * próprio prazo e falhar sozinho, desfazendo o que criou antes de sair
 * (sessionSteps.ts: lease, retomada; o teto de uma operação inteira está em
 * SESSION_OPERATION_CEILING_MS).
 */
export interface ConversationLock {
  run<T>(convId: string, work: () => Promise<T>): Promise<T>
}

export function createConversationLock(): ConversationLock {
  const tails = new Map<string, Promise<unknown>>()

  return {
    run<T>(convId: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(convId) ?? Promise.resolve()
      // `previous` nunca rejeita (é o `tail` de quem veio antes). A vez só passa
      // quando `work` assenta — resolvida ou rejeitada, nunca por tempo.
      const mine = previous.then(() => work())
      const tail = mine.catch(() => undefined)
      tails.set(convId, tail)
      // A última da fila leva a entrada junto: o mapa não cresce com conversas paradas.
      void tail.then(() => {
        if (tails.get(convId) === tail) tails.delete(convId)
      })
      return mine
    }
  }
}
