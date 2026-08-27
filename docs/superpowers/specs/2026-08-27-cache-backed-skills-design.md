# Skills persistentes na pasta de dados

## Objetivo

Todas as skills disponibilizadas pelo Agent Code devem funcionar em qualquer projeto e permanecer vinculadas à pasta escolhida pelo usuário em **Pasta de dados (cache)**. Nenhuma skill pode depender do caminho atual do checkout do repositório.

## Arquitetura

A fonte ativa das skills será `<cacheDir>/skills/<nome>/SKILL.md`, ao lado do banco, das conversas e das memórias. As skills empacotadas em `.agents/skills` serão sincronizadas para esse diretório na inicialização do aplicativo. Skills externas já existentes no cache serão preservadas.

O diretório global `%USERPROFILE%/.claude/skills` continuará sendo o ponto de descoberta nativa do Claude Code. Para cada skill ativa, o Agent Code manterá uma junction com o mesmo nome apontando para `<cacheDir>/skills/<nome>`. Junctions quebradas ou criadas anteriormente pelo Agent Code e apontando para checkouts antigos serão reparadas. Diretórios reais e links externos que não pertencem ao Agent Code não serão removidos.

O catálogo exibido no autocomplete e injetado nas sessões será produzido pela mesma descoberta usada em runtime, incluindo as skills do cache. Assim, a interface não anunciará uma skill que o runtime não consegue carregar.

## Inicialização e troca de cache

Depois de inicializar o store, o processo principal deverá:

1. criar `<cacheDir>/skills`;
2. sincronizar as skills empacotadas para o cache;
3. reparar as junctions globais;
4. descobrir as skills a partir do cache para novas sessões e para o autocomplete.

Quando o usuário trocar a pasta de dados, o mecanismo existente moverá o diretório `skills` junto com o restante do cache se o destino estiver vazio. Em seguida, a sincronização será executada novamente no novo destino e as junctions globais serão atualizadas imediatamente. Conversas já em execução continuam com o catálogo registrado quando foram iniciadas; novas conversas e reconexões usam o cache novo.

## Sincronização e preservação

As skills empacotadas são copiadas recursivamente para o cache e atualizadas pelo aplicativo, garantindo que correções distribuídas em versões novas cheguem ao usuário. A sincronização atua apenas nos nomes fornecidos pelo Agent Code. Skills adicionais criadas ou instaladas pelo usuário no cache não são apagadas.

Para distinguir links gerenciados pelo Agent Code de instalações externas, a reparação só substitui junctions quebradas ou links cujo destino esteja dentro de uma pasta `.agents/skills` do Agent Code ou dentro de uma pasta de cache anterior. Um diretório real existente no perfil global é preservado e relatado como conflito, sem exclusão automática.

## Falhas

Uma falha ao copiar uma skill ou criar uma junction não deve impedir o aplicativo de abrir. O erro deve ser registrado com o nome da skill e o caminho envolvido. A skill indisponível não deve aparecer como funcional no catálogo da sessão.

## Validação

Testes automatizados cobrirão:

- primeira sincronização para um cache vazio;
- atualização de skill empacotada;
- preservação de skill externa;
- reparação de junction quebrada ou ligada ao checkout antigo;
- preservação de diretório global não gerenciado;
- nova sincronização após troca da pasta de cache;
- descoberta e catálogo usando a pasta ativa.

Após a implementação serão executados `npm run typecheck`, `npm test`, `npm run build` e uma verificação real dos `SKILL.md` acessíveis pelas junctions globais.
