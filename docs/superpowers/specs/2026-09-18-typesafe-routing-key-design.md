# TypeSafe — chave tipada de roteamento automático

## Decisão

O modo **Automático** usará o TypeSafe AI como uma camada de decisão anterior à
criação (ou reutilização) da sessão do agente. A chave de roteamento é uma
intenção tipada, não uma string produzida pelo modelo: o turno fornece a
mensagem nova, o histórico contextual e, quando aplicável, o modelo que já está
ativo; a resolução devolve um par fechado `model + effort` e a origem da decisão.

O valor `auto` é apenas um sentinela de UI/configuração. Nunca pode atravessar a
fronteira do provider. Antes de montar uma sessão, o processo main resolve
`auto` para um modelo Claude real e um nível de esforço suportado por ele. Se o
TypeSafe estiver desligado, sem credencial, indisponível, atrasar ou retornar
resposta inválida, o envio continua com o par de fallback definido pelo
contrato, sem bloquear o turno do usuário.

## Objetivo e fora de escopo

O objetivo é centralizar a decisão por turno, preservar o custo de cache quando
isso for seguro e manter o contrato existente de seleção manual. A decisão deve
ser determinística quanto às listas oferecidas, validação e fallback, embora a
classificação do serviço seja probabilística. A confiança retornada participa do
gate somente quando já existe um par live decidido. O piso padrão é
`minConfidence = 0.20`: abaixo dele, preserva-se o par live; sem par live, uma
resposta estruturalmente válida continua aceita.

Ficam fora de escopo:

- permitir que o TypeSafe envie a mensagem ao provider ou execute ferramentas;
- aceitar um modelo arbitrário retornado pelo serviço, fora da lista oferecida;
- expor a chave da API, conteúdo bruto da conversa ou resposta bruta do serviço;
- trocar provider (Claude, GPT ou Ollama) por meio desta decisão;
- retry, backoff ou uma fila que atrase o envio principal;
- fazer do fallback uma decisão persistente para os próximos turnos;
- alterar o seletor manual ou o protocolo de sessões não automáticas.

## Arquitetura proposta

### Contrato compartilhado

`src/shared/ipc.ts` permanece a fonte única dos contratos e catálogos:

- `AUTO_MODEL = "auto"` identifica o modo, mas não é um modelo de provider;
- `CLAUDE_MODELS`, `MODEL_EFFORT` e `EFFORT_LEVELS` definem candidatos e limites;
- `AutoPrompt` separa `message` de `history` (`user`/`agent`);
- `AutoExecution` contém `model`, `effort` e `source` (`typesafe`, `fallback` ou
  `unprompted`);
- `AutoLivePair` acrescenta `decided`, distinguindo uma escolha real de um
  par temporário de fallback;
- `minConfidence` define o piso padrão `0.20` para o gate aplicado a um par live
  decidido;
- `clampEffortToModel` é a última barreira antes de o par deixar o processo.

A lista candidata deve ser derivada do mesmo catálogo mostrado ao usuário. Uma
lista restrita, como a usada por observadores de memória, continua sendo
honrada; o fallback nunca pode furar essa restrição.

### Camada TypeSafe

`src/main/typesafe/client.ts` é o único ponto de acesso ao SDK. Ele verifica o
interruptor vivo, resolve a credencial primeiro da configuração e depois do
cofre, envia uma chamada `systemOne` tipada, usa timeout de 8 segundos por
padrão e zero retries. Qualquer erro retorna `null` e não propaga exceção para o
turno principal. Uso retornado pelo serviço é contabilizado de modo assíncrono
e serializado por `src/main/typesafe/usage.ts`.

`src/main/typesafe/execution.ts` monta duas perguntas na mesma chamada quando
há escolha: `choice` para o modelo e `score` para a escada ordenada de esforço.
O estado enviado usa chaves estáveis (`conversa`, `mensagem_nova`,
`modelo_atual`) e instruções que dizem explicitamente que texto dentro de
`state` é conteúdo a avaliar, não comando. O score é arredondado e preso à
escada; o modelo é aceito somente se pertencer aos candidatos enviados.

A sequência de resolução é:

1. Se não houver mensagem nova, não há classificação: retorna `unprompted` e
   preserva o par vivo quando existir.
2. Se não houver duas opções em nenhuma dimensão, não se faz uma pergunta
   desnecessária; na ausência de decisão, usa-se `fallback`.
3. Se houver um par live decidido, a resposta só substitui esse par quando
   `confidence >= minConfidence`; com o piso padrão `minConfidence = 0.20`, uma
   resposta abaixo de `0.20` preserva o par live. Sem par live decidido, uma
   resposta estruturalmente válida é aceita mesmo abaixo do piso.
4. O modelo e o esforço permanecem validados contra as listas e limites
   oferecidos; o esforço é recortado contra o modelo escolhido, depois que
   ambos são conhecidos.
5. O handler de sessão usa `reuse` somente quando a sessão viva já corresponde
   exatamente ao par resolvido; caso contrário, recria a sessão antes do turno.
6. A nota de sistema informa ao usuário a escolha TypeSafe ou o fallback, mas
   não anuncia nada para `unprompted`.

### Persistência e estado vivo

A origem do par é essencial. Um fallback não vira uma decisão persistente: no
próximo turno, uma nova decisão pode escolher outro par. Uma resposta
`typesafe` estruturalmente válida abaixo de `minConfidence` preserva um par live
decidido, mas é aplicada sem live decidido; uma resposta
válida acima ou igual ao piso substitui o par quando validada. O par resultante
é propagado durante reconexão sem turno. O contador
`agentcode.typesafe.usage.v1` é informativo e best-effort; falha de storage não
pode desfazer uma escolha já entregue.

## Validação e invariantes

- `AUTO_MODEL` nunca chega ao SDK, CLI, proxy ou provider.
- `model` final deve estar no catálogo permitido da chamada que o escolheu.
- `effort` final deve ser um item de `EFFORT_LEVELS` e compatível com
  `MODEL_EFFORT[model]` quando houver teto conhecido.
- Respostas TypeSafe ausentes, `noul`, fora da lista, `NaN`, infinitas ou fora
  da faixa caem em comportamento seguro e não produzem `undefined`; `confidence`
  abaixo de `minConfidence` preserva o par live decidido, mas não impede uma
  resposta válida quando não existe par live.
- `modelo_atual` só é enviado se o par vivo estiver entre os candidatos; caso
  contrário usa o marcador `nenhum`.
- Histórico serve apenas como contexto; não pode substituir a mensagem nova
  nem alterar a autoridade das instruções internas.
- Uma chamada sem perguntas não deve consumir credencial nem chamar o SDK.
- Falha, timeout, cancelamento, chave ausente ou storage indisponível não pode
  lançar pelo caminho do envio principal.
- A sessão só é reutilizada quando `model` e `effort` coincidem; configuração
  alterada ou sessão perdida exige nova montagem quando não há turno.

## Segurança e privacidade

A credencial deve ser lida no momento da chamada, sem persistir a chave no
payload de decisão, estado da conversa, eventos de UI ou contador de uso. Logs
podem registrar apenas diagnóstico sanitizado; não devem incluir chave, estado,
histórico, headers ou resposta bruta.

O TypeSafe recebe somente o estado mínimo necessário para classificar o turno.
As perguntas e listas são construídas no main a partir de catálogos confiáveis;
nenhum texto da conversa pode criar uma nova chave de roteamento, modelo,
esforço ou instrução de sistema. A resposta do serviço é dado não confiável e
passa por validação estrutural e por pertinência à lista oferecida antes de
qualquer efeito.

Não há execução de ferramenta ou escrita de quadro como consequência direta da
classificação. A decisão apenas escolhe parâmetros que o caminho normal de
sessão já valida. O fallback preserva disponibilidade e evita transformar uma
falha de serviço auxiliar em indisponibilidade do agente.

## Plano de testes e critérios de aceite

A implementação deve manter ou ampliar os testes existentes em
`src/main/typesafe/*.test.ts` e nos pontos de integração da sessão:

1. **Cliente:** modo desligado, chave em config, chave no cofre, ausência de
   chave, timeout, abort, 401/429/rede e zero retries retornam `null`; nenhuma
   exceção atravessa a API.
2. **Payload:** estado e histórico têm as chaves esperadas; modelo vivo inválido
   vira `nenhum`; perguntas de modelo/esforço usam as listas e não são enviadas
   quando não há escolha.
3. **Validação:** escolha fora da lista, score negativo/acima da faixa,
   `NaN`/infinito, resposta `noul` ou ausência estrutural produzem fallback
   seguro; modelo e esforço continuam validados; com par live decidido,
   resposta válida abaixo de `minConfidence = 0.20` preserva o par, enquanto
   resposta válida em `0.20` ou acima é aceita; sem par live, resposta válida
   abaixo de `0.20` também é aceita.
4. **Compatibilidade:** Haiku nunca recebe esforço acima de `high`; todos os
   modelos suportados aceitam os pares previstos; `auto` nunca é passado ao
   provider.
5. **Decisão por turno:** com par live decidido, resposta abaixo de `0.20`
   preserva o par e resposta válida em `0.20` ou acima pode substituí-lo; sem
   live, resposta estruturalmente válida abaixo do piso é aceita; fallback não
   se torna decisão; reconexão sem turno preserva o par correto sem emitir nota.
6. **Sessão:** mesmo par reutiliza sessão; mudança de modelo/esforço recria;
   mensagem nova sempre segue mesmo quando TypeSafe falha.
7. **Uso:** chamadas concorrentes somam tokens e chamadas sem perder uma escrita;
   JSON corrompido ou storage fora do ar volta a zero sem quebrar a decisão.
8. **Integração/UI:** notas de escolha e fallback são exibidas uma vez, enquanto
   `unprompted` permanece silencioso; seleção manual não passa pelo TypeSafe.

Critérios de aceite: `npm test` (ou o comando equivalente documentado pelo
projeto) passa sem alterações de snapshots; testes de contrato comprovam que
nenhum sentinela ou segredo alcança provider/log/evento; e uma falha completa do
TypeSafe ainda entrega a mensagem com o par fallback válido.

## Arquivos envolvidos na futura implementação

- `src/shared/ipc.ts`: tipos, catálogos, sentinário e clamp;
- `src/main/typesafe/client.ts`: fronteira SDK, credencial e timeout;
- `src/main/typesafe/execution.ts`: payload, validação e resolução;
- `src/main/typesafe/usage.ts`: contador best-effort serializado;
- `src/main/agentSession.ts` e `src/main/index.ts`: integração de sessão e IO;
- `src/main/typesafe/*.test.ts` e testes de sessão/UI: cobertura dos critérios.

Esta entrega é somente a especificação. Nenhum arquivo de código-fonte, contrato
ou teste deve ser alterado durante esta tarefa.
