---
name: planejar
description: >-
  Planejar e executar mudanças de código complexas em marcos verificáveis. Use quando o pedido
  envolver múltiplos subsistemas ou dependências, decisões arquiteturais, alto risco ou impacto,
  contratos, migrações ou efeitos externos, ou quando o usuário pedir "planejar", "passo a
  passo" ou "por etapas". Se o usuário pedir apenas um plano, não implemente. Sem pedido explícito
  de planejamento, não acione somente pela quantidade de arquivos; resolva diretamente mudanças
  atômicas de baixo risco e dúvidas conceituais.
---

# Planejar — execução guiada por marcos

Organize trabalho complexo sem cerimônia desnecessária. Ajuste o rigor ao risco, preserve o
escopo autorizado e siga as instruções do repositório.

## 1. Classificar o pedido

- Distinguir **somente planejar** de **planejar e executar**. No primeiro caso, entregar o plano
  e parar antes de editar, testar, comitar ou realizar efeitos externos.
- Quando o usuário pedir um plano, respeitar o formato mesmo para uma mudança pequena e ajustar o
  detalhamento ao risco.
- Tratar como complexo o trabalho que exija vários marcos dependentes, atravesse subsistemas,
  altere contratos ou persistência, tenha grande impacto ou envolva incerteza relevante.
- Sem pedido de plano, tratar como direto o trabalho atômico e de baixo risco, mesmo que uma
  alteração mecânica toque vários arquivos; sair deste protocolo e seguir o fluxo normal do
  projeto. Não exigir runtime para perguntas conceituais sem mudança.
- Usar número de arquivos apenas como sinal auxiliar, nunca como critério decisivo.

## 2. Preparar o trabalho

1. Ler as instruções fornecidas pelo ambiente e pelo repositório, respeitando sua hierarquia.
   Inspecionar os arquivos, contratos, scripts e testes relevantes.
2. Inspecionar `git status` e o diff existente antes de editar. Identificar mudanças do usuário e
   evitar sobrescrevê-las, misturá-las ao escopo ou incluí-las em futuras operações Git.
3. Quando viável, estabelecer o baseline dos checks relevantes. Distinguir regressão nova de
   falha preexistente e não ampliar o escopo para corrigir falhas antigas sem necessidade.
4. Preferir o planejamento nativo do ambiente. Persistir um plano somente se o usuário pedir ou
   se a retomada exigir; usar caminho único, resumir requisitos e omitir prompt bruto, segredo e
   PII.
5. Dividir o trabalho em marcos ordenados por dependência. Registrar em cada um o resultado
   observável, o escopo provável e os fluxos aplicáveis de validação. Exigir integração segura,
   não um commit isolado.
6. Pedir decisão ao usuário somente quando faltar uma escolha material, houver expansão de
   escopo, ação destrutiva, efeito externo, operação em produção ou nova autoridade necessária.
   Se o pedido já autorizar a implementação e estiver claro, comunicar o plano e prosseguir.

## 3. Executar por marcos

- Manter um marco por vez quando houver escopo sobreposto. Paralelizar pesquisa, revisão,
  validação ou escritas disjuntas somente quando não houver risco de corrida.
- Ler cada arquivo antes de editá-lo e seguir os padrões reais do projeto. Aplicar outras skills
  apenas quando forem pertinentes e estiverem disponíveis; não depender de comandos ou skills
  inexistentes.
- Atualizar o plano quando surgir trabalho necessário. Resolver o que estiver no escopo e parar
  somente quando faltar decisão ou autoridade.
- Corrigir regressão causada pelo marco antes de avançar. Registrar separadamente falhas
  preexistentes que não pertençam ao pedido.

## 4. Validar de forma proporcional e segura

Por marco, executar checks direcionados e o menor fluxo de runtime que demonstre o comportamento.
Ao final, executar os checks exigidos pelo repositório e a validação integrada aplicável. Não
rodar cegamente todo script depois de cada microalteração.

Checks verdes não substituem comportamento observado. Em mudança executável, rodar o app ou
serviço antes de afirmar que funciona. Se isso for impossível, informar exatamente a lacuna e não
declarar a funcionalidade concluída.

### Frontend, quando aplicável

- Montar, sair da rota ou contexto e remontar; confirmar se o estado deve persistir ou limpar.
- Recarregar a aplicação quando o fluxo existir.
- Exercitar loading, vazio, erro, troca de contexto e permissão afetada pela mudança.
- Exercitar criar, listar, editar e excluir somente quando fizerem parte do fluxo.
- Para imagem, preview, blob, object URL, stream ou áudio, testar montar, desmontar e remontar.

### Backend, quando aplicável

- Usar ambiente local, de teste ou staging autorizado com dados sintéticos. Não alterar produção
  nem gerar efeito externo real sem autorização explícita.
- Executar o endpoint ou processo integrado; verificar resposta, logs, persistência, sucesso,
  validação, autorização e falhas relevantes.
- Testar migrações em banco controlado conforme a semântica do projeto. Exigir reaplicação segura
  ou no-op apenas quando isso fizer parte do contrato da ferramenta.
- Confirmar entrega real a webhook, fila, email ou API de terceiro somente com autorização,
  credenciais apropriadas e destino de teste. Caso contrário, usar testes de contrato/integração e
  declarar a limitação.

Ao encontrar regressão, corrigir e repetir os checks e fluxos afetados antes de marcar o marco
como concluído.

## 5. Revisar, versionar e entregar

1. Quando houver implementação, aplicar `code-review` ao escopo explícito antes da entrega ou de
   qualquer commit. Usar o working diff sem commits; com commits intermediários autorizados,
   registrar o SHA-base e revisar `base..HEAD`, ou revisar cada marco antes de comitá-lo.
2. Corrigir achados confirmados e repetir os checks e fluxos afetados. Fazer a auditoria final
   somente depois da revisão e da revalidação.
3. Preparar stage, commit ou push somente com autorização explícita. Inspecionar status e diff e
   incluir apenas arquivos ou hunks do trabalho atual.
4. Comparar o resultado com os requisitos mais recentes da conversa, não apenas com o primeiro
   prompt. Confirmar que cada critério de aceitação foi coberto.
5. Concluir o plano nativo e remover apenas artefatos temporários que não precisem ser preservados.
6. Entregar um resumo com mudanças, evidências de validação e limitações reais. Não transferir ao
   usuário uma verificação funcional que o agente poderia executar; pedir ao usuário apenas
   julgamento subjetivo ou acesso e autoridade indisponíveis.
