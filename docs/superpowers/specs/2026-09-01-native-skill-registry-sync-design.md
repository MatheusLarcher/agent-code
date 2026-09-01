# Sincronização do catálogo com o registro nativo de skills

## Contexto

O Agent Code possui hoje duas descobertas diferentes:

- o catálogo próprio varre `.claude/skills`, `.agents/skills`, `<cacheDir>/skills` e `~/.claude/skills`;
- a ferramenta nativa `Skill`, fornecida pelo Claude Agent SDK, carrega apenas as raízes que o SDK reconhece como nativas.

Por isso uma skill pode aparecer no catálogo injetado na sessão e ainda falhar com `Unknown skill`. A recarga atual também considera `reloadSkills()` bem-sucedido sem conferir se a resposta contém as skills esperadas.

Este design complementa `2026-08-27-cache-backed-skills-design.md`: o cache continua sendo a fonte persistente das skills gerenciadas pelo Agent Code, e `~/.claude/skills` continua sendo a ponte para o registro nativo.

## Objetivo

Toda skill anunciada como disponível pelo Agent Code deve ser invocável pela ferramenta `Skill`, inclusive quando ela for adicionada ou atualizada depois que a sessão já começou.

A aplicação nunca deve marcar uma versão do registro como carregada se o SDK não confirmar as skills esperadas.

## Autoridade e raízes

O conjunto invocável será formado somente por raízes nativas verificáveis:

1. `<project>/.claude/skills`, descoberta diretamente pelo SDK no projeto ativo;
2. `~/.claude/skills`, contendo instalações reais do usuário e junctions gerenciadas pelo Agent Code;
3. `<cacheDir>/skills`, exposto em `~/.claude/skills` por junctions gerenciadas.

`<project>/.agents/skills` continuará sendo a fonte versionada das skills distribuídas com o Agent Code, mas não será tratado como uma raiz nativa independente. Seu conteúdo será sincronizado para `<cacheDir>/skills` e então exposto em `~/.claude/skills`, seguindo o fluxo já definido para skills persistentes.

O catálogo da sessão não poderá anunciar como invocável uma entrada que exista apenas numa raiz não exposta ao SDK.

## Fluxo de sincronização a quente

Antes de recarregar o registro nativo, quando a assinatura dos arquivos de skill mudar, o Agent Code executará esta sequência:

1. sincronizar as skills versionadas de `.agents/skills` para `<cacheDir>/skills`;
2. criar ou reparar as junctions gerenciadas em `~/.claude/skills`;
3. reconstruir o catálogo a partir das raízes nativas resultantes;
4. chamar `reloadSkills()` no SDK;
5. comparar os nomes retornados pelo SDK com as skills esperadas pelo catálogo;
6. somente após a correspondência, registrar a versão como carregada e injetar a atualização do catálogo na sessão.

A sincronização deve ser idempotente. Se os arquivos não mudaram, nenhum link será refeito e nenhuma nova recarga será disparada.

## Precedência e colisões

A precedência continuará respeitando o escopo mais específico:

1. skill nativa do projeto em `<project>/.claude/skills`;
2. instalação real do usuário em `~/.claude/skills`;
3. skill gerenciada no cache e exposta por junction.

O Agent Code não sobrescreverá nem removerá diretório real ou link externo não gerenciado existente em `~/.claude/skills`. Quando uma skill do cache colidir com uma instalação real do usuário, a instalação do usuário prevalecerá e o conflito será registrado.

Skills com nome de frontmatter diferente do nome do diretório serão consideradas inválidas para exposição nativa. Elas não serão anunciadas até o nome ser corrigido, evitando que catálogo e SDK usem identificadores diferentes.

## Validação da recarga

`reloadSkills()` será tratado como uma operação com resultado, não apenas como um comando que pode resolver ou rejeitar.

Após a chamada:

- todas as skills esperadas devem aparecer na resposta do SDK;
- se alguma estiver ausente, a versão nativa continuará pendente;
- a falha será registrada com os nomes ausentes e as raízes esperadas;
- a próxima mensagem tentará novamente após nova sincronização;
- o catálogo não será atualizado para anunciar uma skill ainda não confirmada.

Uma skill nativa adicional devolvida pelo SDK não é erro. Ela poderá entrar no catálogo na próxima descoberta normal, desde que sua origem seja uma raiz autorizada.

## Falhas e segurança

Falha ao copiar uma skill, reparar uma junction ou recarregar o SDK não impedirá o Agent Code de abrir nem derrubará a sessão atual. A skill afetada ficará indisponível e não será anunciada como funcional.

A sincronização só poderá alterar junctions reconhecidas como gerenciadas pelo Agent Code. Diretórios reais, junctions externas e skills do usuário serão preservados.

A atualização do catálogo continuará sendo uma substituição autoritativa completa, sem acumular catálogos antigos no contexto.

## Componentes afetados

- `src/main/skillManager.ts`: separar e reutilizar a exposição cache → raiz nativa durante a sessão.
- `src/main/skillDiscovery.ts`: produzir o conjunto esperado a partir de raízes realmente nativas e validar nome de diretório/frontmatter.
- `src/main/agentSession.ts`: sincronizar antes da recarga, validar `reloadSkills().skills` e controlar a versão confirmada.
- `src/main/index.ts`: manter a sincronização da inicialização e da troca de cache usando a mesma implementação idempotente.
- testes de `skillManager`, `skillDiscovery`, `agentSession` e integração real com o Claude Agent SDK.

## Testes e critérios de aceite

A implementação será aceita quando estes cenários passarem:

1. skill presente antes da sessão é carregada na primeira mensagem;
2. skill adicionada a `.agents/skills` depois da sessão começar é sincronizada, recarregada e invocável sem reiniciar o aplicativo;
3. skill adicionada diretamente ao cache depois da sessão começar recebe junction e fica invocável;
4. skill nativa de `<project>/.claude/skills` continua funcionando;
5. instalação real do usuário em `~/.claude/skills` não é sobrescrita por colisão do cache;
6. diferença entre nome do diretório e frontmatter não é anunciada como funcional;
7. resposta de `reloadSkills()` sem uma skill esperada não marca a versão como carregada e provoca nova tentativa;
8. remoção de skill gerenciada retira sua junction e seu nome do catálogo sem tocar em skills externas;
9. teste com o SDK real cria uma skill depois de a query iniciar, recarrega e usa a ferramenta `Skill` para ler o conteúdo correto;
10. `npm run typecheck`, suíte automatizada e build terminam sem erros.

A verificação final deve provar o fluxo completo — arquivo criado, catálogo atualizado, registro confirmado e chamada real de `Skill` — e não apenas contar chamadas a `reloadSkills()`.