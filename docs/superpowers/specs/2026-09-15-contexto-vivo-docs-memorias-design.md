# Contexto vivo de documentação e memórias

## Contrato

Toda chamada efetiva iniciada pelo Agent SDK recebe o retrato atual de `docs/` e os excertos de memória relevantes ao pedido ativo. O contrato é comum aos modelos Claude, GPT/Codex e Ollama: o aplicativo produz um único bloco de contexto neutro; a rota só escolhe o transporte.

`docs/*.md` diretamente sob a raiz entra por completo, respeitando o teto agregado e as verificações de arquivo seguro. Markdown em subdiretórios entra apenas pelo caminho e pelas três primeiras linhas físicas. Symlinks, escapes de caminho, arquivos instáveis e binários continuam marcados/omitidos por `projectOutline`.

## Mecanismo suportado

O Agent SDK não oferece mutação ao vivo de `Options.systemPrompt` depois de `query()` começar. Em vez disso, `UserPromptSubmit` retorna `hookSpecificOutput.additionalContext` antes da primeira request de um turno, e o hook TypeScript `PostToolBatch` retorna o mesmo campo uma vez após uma bateria de ferramentas e antes da request seguinte. Ambos recriam o outline; portanto uma edição em `docs/` durante uma ferramenta chega à continuação do loop.

O bloco não é prefixado ao `SDKUserMessage` persistido. Esse histórico guarda somente o texto do usuário, o carimbo de origem e atualizações de catálogo que já existiam; não recebe cópias integrais de documentação por turno. Isso evita crescimento multiplicativo e mantém a fonte de documentação atual no limite real da request.

## Memórias e segurança

A cada limite de request, `buildDynamicMemoryContext(memoriesDir, activeTask, false)` seleciona no máximo três excertos limitados, sem reproduzir o índice completo. O caminho existente continua recursivo, ignora symlinks e limita tamanho/leitura. Referências de cofre e atribuições comuns de credencial são redigidas antes da injeção; o único caminho para valores reais permanece a autorização explícita do cofre.

## Adaptadores de provedor

O mesmo contexto vivo passa pelo Agent SDK para todos os modelos. Para GPT/Codex, o adaptador preserva o campo Anthropic `system` como `instructions`, e a variante Responses Lite o leva ao prefixo `developer`; não há conversão de docs em mensagem de usuário nem alteração de credenciais/roteamento de GPT ou Ollama.

## Verificação

Testes cobrem o histórico sem docs, os dois limites de request e atualização de docs após ferramenta, paridade entre provedores, posicionamento developer do Codex, previews físicos de Markdown aninhado e redação de excertos de memória.
