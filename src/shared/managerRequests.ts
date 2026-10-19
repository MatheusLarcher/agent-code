/**
 * Pedidos fixos ao Agent Manager que o PC e o celular mandam pelo envio normal
 * da conversa de planejamento. Fonte única do texto: o botão do PC
 * (planning/handoffFlow reexporta) e o do celular (phone/planning/PlanChat).
 */

/**
 * O pedido do botão "Iniciar questionário" (chat do Agent Manager): lançar
 * como AskUserQuestion as perguntas em aberto do plano, em levas, e registrar
 * as respostas nos cards. Vai pelo caminho normal de envio (fila, se ocupado).
 *
 * As perguntas saem do ROTEIRO (etapa por etapa) e de pesquisa na web sobre o
 * que o usuário disse — não da memória do Manager, que declarava "nenhuma
 * pergunta" com etapas ainda pendentes.
 */
export function managerQuestionnaireRequest(): string {
  return (
    'Lance agora o questionário. Antes de perguntar, leia o plano com mcp__planning__plan_read e percorra o ' +
    'roteiro etapa por etapa: para cada etapa não concluída, levante o que o usuário ainda precisa decidir para ' +
    'ela poder ser implementada (decisões, dados, critérios de aceite, riscos), junto das ambiguidades abertas e ' +
    'das lacunas que você apontou. Com base no que o usuário já disse, pesquise na web (WebSearch/WebFetch) ' +
    'práticas, bibliotecas e limitações relevantes e transforme o que achar em perguntas com opções concretas. ' +
    "Faça-as com AskUserQuestion, até 4 por vez, com a sua recomendação como primeira opção e marcada '(Recomendado)'. " +
    'Depois de cada resposta, registre nos cards (decisão, ambiguidade resolvida), marque a etapa concluída com ' +
    'mcp__planning__plan_etapa_marcar quando ela ficar especificada e lance a próxima leva, até acabarem. ' +
    'Etapa que não precise de nada do usuário: diga por quê e marque-a concluída. Só diga ' +
    "'Nenhuma pergunta em aberto.' se todas as etapas do roteiro estiverem concluídas e não houver ambiguidade " +
    'aberta. Não implemente nada.'
  )
}
