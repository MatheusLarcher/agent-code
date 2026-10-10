---
id: "dec-injecao-falhas-validacao"
tipo: "decisao"
titulo: "Validação com injeção de falhas só em dev"
etapa: "validacao"
status: "aceita"
links: ["req-identificar-erro","req-retomar-de-onde-parou","req-fila-nunca-se-perde","req-segundo-item-so-no-fim-real","dec-stop-pausa-fila","amb-tentativas-esgotadas"]
fonte: "src/main/testing/electronMocks.ts"
rev: 2
---
**Por quê:** o "pronto" deste trabalho exige rodar o app e ver cada cenário acontecer, não só o vitest verde (Definition of Done do usuário). Esperar um 529 de verdade não é teste. Precisa de um jeito determinístico de provocar cada falha.

**O quê:** uma variável de ambiente só de desenvolvimento (ex.: `AGENT_CODE_FAULT=api_error|silencio|exit0|exit1|nao_iniciou|auth`) lida no main, que faz a **próxima** sessão falhar daquele jeito: corta o iterador, segura as mensagens, emite um `result` com `is_error` etc. Desligada no build empacotado (`app.isPackaged`) e sem efeito quando ausente. Prazos (aborto por silêncio, esperas da retentativa) encurtáveis por variável, só em dev, para o teste não levar 33 min.

**Cenários obrigatórios no app real** (cada um conferido também no log de sessão):
1. Fila com 3 itens + erro de API no meio do item 1, depois de o modelo já ter falado → item 1 retomado com "continue"; item 2 só sai quando o 1 concluir.
2. Silêncio → aviso em 60 s, aborto no prazo, retomada sozinha, fila intacta.
3. CLI sai com código 0 no meio → erro `processo_encerrado`, sessão nova com resume, retomada.
4. CLI morre antes de ler a mensagem → reenvio do original (não "continue").
5. Stop com fila → fila **pausada**; continua pausada depois de F5 e de reiniciar o app; "Continuar" despacha a cabeça; "Limpar" descarta e avisa Central e Forgia; mensagem nova sai na hora e a fila continua pausada; o "não era aqui" da Central continua soltando a fila sozinho.
6. Matar o app no meio do turno com fila → ao abrir, retomada do item em voo, fila igual, nada roda duas vezes.
7. Tentativas esgotadas (6, esperas 30 s → 15 min, encurtadas) → fila retida; "Tentar de novo", "Pular esta tarefa" e "Limpar" no PC; "Tentar de novo" e "Cancelar" (= pausar) no celular; mensagem nova vira retomada guiada sem pular a tarefa.
8. Erro fatal (simular auth) → para sem gastar tentativas, fila retida.
9. Turno normal sem falha → conta como concluído e a fila anda. O caso "resposta inteira + erro no fim" (reproduzir no provedor em que acontece) também.
10. Limite de uso → espera o reset (comportamento de hoje preservado).

Mais: remontar (sair e voltar à conversa), F5 durante a espera de uma retentativa e estado vazio (falha sem fila). Conferir no `env` do CLI o `CLAUDE_ENABLE_STREAM_WATCHDOG=1`.
