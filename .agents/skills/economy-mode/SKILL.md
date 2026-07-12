---
name: "Modo econômico"
description: "Modo de economia de tokens para tarefas simples. Quando ativado pelo toggle na UI, instrui o LLM a pular validações, testes e verificações desnecessárias — apenas para tarefas triviais. NUNCA use este modo a menos que o toggle de economia esteja marcado na interface."
---

# Modo Econômico (Economy Mode)

## O que este modo faz

Quando o toggle **💰 Econômico** está ATIVADO na interface (ao lado do seletor de modelo), você DEVE seguir estas regras para economizar tokens:

### Regras de economia

1. **Pule typecheck e build para tarefas triviais** — Se a mudança for puramente textual (ex.: arrumar um typo, mudar uma label, ajustar um comentário, alterar uma string), NÃO rode `npm run typecheck` nem `npm run build`. Só edite e pronto.

2. **Pule testes para mudanças pontuais** — Se a mudança for em 1 arquivo, sem alteração de lógica (ex.: CSS/Tailwind, texto de UI, ajuste visual simples), NÃO rode `npm test`. Assuma que funciona.

3. **Não revalide o código após editar** — Não releia o arquivo depois de editá-lo para "confirmar que ficou certo". O Edit/Write já teria falhado se algo desse errado. Confie no tooling.

4. **Sem verificações redundantes** — Não faça grep/ls/glob para "confirmar" algo que você já sabe. Se a informação já está no contexto, use-a diretamente.

5. **Respostas mais curtas** — Seja direto e conciso. Não explique o que fez a menos que o usuário pergunte. Um "✅ pronto" ou "feito" é suficiente para tarefas simples.

6. **Sem "Definition of Done" completo** — As regras normais de validação (rodar o app, testar fluxo real, verificar estado vazio/erro) NÃO se aplicam. Apenas faça a mudança e siga em frente.

### O que NÃO muda

- **Segurança**: Nunca pule verificações de segurança. Se a mudança envolve credenciais, secrets, ou dados sensíveis, trate com o cuidado normal.
- **Mudanças complexas**: Se a tarefa envolve múltiplos arquivos, alterações de lógica, ou refatoração, IGNORE o modo econômico e siga o fluxo normal completo.
- **Commits**: Continue não fazendo push automático. Só commitar quando o usuário pedir.

### Resumo

| Tipo de tarefa | Modo econômico | Modo normal |
|---|---|---|
| Typo / label / string | Editar → ✅ pronto | Editar → typecheck → build → test |
| CSS / visual simples | Editar → ✅ pronto | Editar → typecheck → build → verificar |
| 1 arquivo, sem lógica | Editar → ✅ pronto | Editar → typecheck → build → test |
| Múltiplos arquivos | ⚠️ Modo normal | Fluxo completo |
| Alteração de lógica | ⚠️ Modo normal | Fluxo completo |
| Segurança / credenciais | ⚠️ Modo normal | Fluxo completo |
