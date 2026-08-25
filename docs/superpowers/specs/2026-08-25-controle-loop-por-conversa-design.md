# Controle seguro de loop por conversa

## Contexto

O Agent Code usa o mesmo harness do Claude Code para modelos Claude e GPT. O
recurso `/loop` pode criar wakeups dinâmicos por meio de `ScheduleWakeup`. Em uma
sessão GPT real, o modelo usou essa ferramenta fora de um loop legítimo para
esperar um subagente, incluiu o campo inexistente `noop: true` e deixou wakeups
antigos reativarem uma tarefa que já havia terminado. O transporte Codex limita
rodadas de ferramentas, mas não controla o ciclo de vida semântico do `/loop`.

## Objetivos

- Dar ao usuário controle explícito do loop em cada conversa.
- Encerrar automaticamente quando a condição pedida pelo usuário for atendida.
- Impedir que GPT ou Claude criem wakeups dinâmicos fora de um loop autorizado.
- Evitar loops infinitos com limite padrão de 100 ciclos, substituível por um
  limite maior explícito no prompt.
- Tornar loop e modo econômico mutuamente exclusivos.
- Persistir a preferência junto da conversa no SQLite do Agent Code.

## Fora de escopo

- Alterar a semântica de agendamentos comuns criados com `CronCreate`.
- Criar um agendador durável próprio para substituir o runtime do Claude Code.
- Permitir que um loop sobreviva ao encerramento deliberado da conversa.

## Estado e interface

A conversa recebe o campo opcional `loopEnabled`. Ausência equivale a `false`,
preservando conversas antigas. O campo segue o mesmo caminho de persistência de
`economyMode`: renderer, registro completo da conversa e banco SQLite por
projeto.

O `ChatPanel` mostra um toggle **Loop** ao lado de **Econômico**. O controle:

- inicia desligado;
- é independente por conversa;
- é restaurado ao reabrir o aplicativo;
- fica visualmente desabilitado enquanto o modo econômico estiver ativo;
- explica no tooltip o limite padrão e o encerramento por condição.

Conversas novas em um projeto herdam `loopEnabled` da conversa de referência do
mesmo projeto, como já ocorre com modelo e modo econômico. A exclusividade é
normalizada na criação e no carregamento: se dados antigos ou corrompidos
trouxerem os dois campos ativos, o modo econômico vence e o loop é desligado.

## Exclusividade com o modo econômico

Ativar **Econômico** deve, na mesma atualização de estado:

1. gravar `economyMode: true`;
2. gravar `loopEnabled: false`;
3. cancelar qualquer wakeup dinâmico pendente da conversa;
4. reiniciar uma sessão ociosa para que o próximo turno receba a configuração.

Ativar **Loop** grava `loopEnabled: true` e `economyMode: false`. Desativar Loop
durante uma execução cancela o ciclo pendente. A alteração deve valer para a
sessão em execução por um comando de controle no processo principal, não apenas
depois de reiniciar o agente.

## Máquina de estados do loop

O controle fica no `AgentSession`, ponto compartilhado por Claude e GPT. Cada
conversa tem no máximo um loop dinâmico ativo:

- `disabled`: toggle desligado; `ScheduleWakeup` dinâmico é negado;
- `armed`: toggle ligado, mas nenhuma skill de loop iniciou um ciclo;
- `running`: a skill `/loop` foi ativada e a condição está sendo trabalhada;
- `waiting`: um próximo wakeup validado está pendente;
- `completed`: condição atendida ou `ScheduleWakeup({ stop: true })` recebido;
- `stopped`: usuário desligou, interrompeu, encerrou ou o limite foi alcançado.

O gate de ferramentas observa a ativação da skill `loop`. `ScheduleWakeup` só é
aceito em `running` ou `waiting`. Tentativas fora desses estados recebem um erro
de ferramenta claro e não criam agendamento. Campos que não pertencem ao schema,
como `noop`, são rejeitados na fronteira.

O próximo wakeup não deve ser confirmado antecipadamente. Uma solicitação de
agendamento durante o ciclo fica registrada como intenção e só é armada no fim
da iteração, depois da avaliação da condição de saída. Isso impede que um
agendamento criado antes da conclusão ressuscite a tarefa.

## Condição de saída

A condição descrita pelo usuário é a regra principal. Exemplos:

- "até terminar essa tela" encerra quando a tela estiver concluída e validada;
- "até os testes passarem" encerra após uma execução bem-sucedida dos testes;
- "até o serviço ficar online" encerra quando a verificação solicitada responder.

Em toda iteração, o prompt de controle manda o modelo avaliar a condição antes
de solicitar outro wakeup. Ao considerá-la atendida, o modelo deve emitir
`ScheduleWakeup({ stop: true })`. O `AgentSession` cancela intenções e wakeups
pendentes e encerra o loop. Se a iteração terminar sem pedir outro wakeup, o
controlador também a considera concluída e não agenda continuação.

O Agent Code não inventa uma condição diferente nem declara sucesso sem a
evidência requerida pelo pedido. Se a condição não puder ser confirmada, o loop
continua até o limite ou termina com erro explícito.

## Limites

O padrão é 100 ciclos por ativação. Um número maior só substitui o padrão quando
o pedido do usuário expressar claramente que ele é o limite do loop, por exemplo
"tente até 250 vezes" ou "limite do loop: 300". Números de porta, datas, ids e
outras quantidades não podem ser interpretados como limite.

Valores menores que 1, não inteiros ou ambíguos usam 100. Haverá um teto técnico
documentado para evitar estouro numérico ou abuso acidental; pedidos acima dele
são reduzidos ao teto com aviso visível. O contador aumenta uma vez por wakeup
efetivamente disparado, não por chamada de ferramenta dentro da iteração.

Ao atingir o limite, o controlador cancela o restante, informa que a condição
não foi confirmada em `N` ciclos e explica que o usuário pode pedir um limite
maior em uma nova execução.

## Cancelamento e encerramento

Devem cancelar intenção e wakeup dinâmico pendente:

- desligar o toggle Loop;
- ativar o modo econômico;
- clicar em interromper/parar;
- excluir ou descartar a conversa;
- atingir o limite;
- receber `ScheduleWakeup({ stop: true })`;
- concluir uma iteração sem solicitar nova continuação.

`CronCreate` não é cancelado automaticamente por essas regras, pois representa
um agendamento recorrente deliberado e separado do `/loop` dinâmico.

## Erros e observabilidade

Erros de controle aparecem no chat sem simular sucesso. Mensagens devem distinguir:

- loop desativado no toggle;
- `ScheduleWakeup` fora de `/loop`;
- entrada de ferramenta inválida;
- limite alcançado;
- cancelamento pelo usuário ou pelo modo econômico.

Logs do processo principal registram transições, contador, limite e motivo do
encerramento, sem registrar prompts completos nem dados sensíveis.

## Testes

Testes unitários e de integração devem cobrir:

- persistência de `loopEnabled` no ciclo salvar/carregar;
- migração implícita de conversa sem o campo;
- herança por projeto e normalização da exclusividade;
- toggles mutuamente exclusivos e cancelamento imediato;
- bloqueio de `ScheduleWakeup` com toggle desligado ou sem skill `loop` ativa;
- rejeição de campos fora do schema;
- limite padrão de 100 e limite maior explícito;
- números irrelevantes no prompt não alterando o limite;
- contagem por wakeup disparado;
- condição atendida via `stop: true`;
- término sem novo wakeup;
- cancelamento por interrupção, descarte e modo econômico;
- `CronCreate` permanecendo independente;
- os mesmos cenários no caminho Claude e no caminho GPT simulado.

Depois dos testes focados, executar `npm run typecheck`, `npm test`,
`npm run build` e `git diff --check`. Se as autenticações disponíveis permitirem,
fazer uma prova real curta com Claude e GPT: uma condição que encerra no segundo
ciclo e outra que é cancelada ao ativar o modo econômico. Testes automatizados
e prova real devem ser relatados separadamente.

## Critérios de aceite

- O usuário controla Loop por conversa e a escolha sobrevive ao reinício.
- Econômico e Loop nunca permanecem ativos ao mesmo tempo.
- Ativar Econômico ou desligar Loop interrompe o ciclo atual.
- A condição do usuário encerra o loop antes do limite.
- Sem conclusão, o padrão encerra em 100 ciclos; um limite maior explícito é
  respeitado dentro do teto técnico.
- GPT não consegue usar `ScheduleWakeup` para esperar subagentes fora de `/loop`.
- Nenhum wakeup antigo reabre uma tarefa concluída.
- Claude e GPT passam pelos mesmos controles de ciclo de vida.
