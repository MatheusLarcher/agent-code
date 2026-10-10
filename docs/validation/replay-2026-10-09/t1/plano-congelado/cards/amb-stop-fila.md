---
id: "amb-stop-fila"
tipo: "ambiguidade"
titulo: "Stop numa sessão travada: a fila fica ou sai?"
etapa: "fila-preservada"
status: "resolvida"
links: ["causa-3-stop-descarta-fila","req-fila-nunca-se-perde","dec-fila-presa-ao-desfecho"]
rev: 2
---
## O que está ambíguo

Hoje o Stop comum **apaga a fila inteira da conversa** (`App.tsx:3436-3465`), avisa a Central que os itens caíram e cancela as tarefas MCP enfileiradas. Isso é de propósito ("Stop = para tudo"). Só que, diante de um travamento, apertar Stop é a reação natural, e é aí que a fila some ([[Causa 3: Stop descarta a fila inteira]]).

Com a detecção e a retomada automáticas, o usuário quase não vai precisar do Stop num travamento. Mesmo assim, ele vai apertar às vezes.

Leituras possíveis:
- **A. Stop nunca descarta.** Para o turno e **pausa** a fila: "Fila pausada (N): Continuar · Limpar". Limpar vira ação separada e explícita.
- **B. Stop continua descartando** (como hoje), agora com confirmação: "Parar e descartar os N itens da fila?".
- **C. Dois botões:** "Parar" (mantém a fila pausada) e "Parar e limpar fila".

Em qualquer leitura, a tarefa parada termina como `interrompido` e **não** é retomada sozinha.

## Cards envolvidos

- [[Causa 3: Stop descarta a fila inteira]]
- [[A fila nunca pode se perder]]
- [[Fila presa ao desfecho: só 'concluido' solta o próximo item]]

## Opinião do Manager

**A.** O pedido foi "a fila nunca pode se perder", sem exceção, e o Stop é justamente o botão que o usuário aperta quando trava. Com A, nada some por acidente e o modelo mental fica simples (Stop para o turno; Limpar limpa a fila). Também é a mais barata: o caminho `keepQueue` já existe, só que hoje ele solta a fila sozinho no fim (`releaseKeptQueue`). Basta trocar isso por "pausada até o usuário mandar continuar".

B mantém o risco (um clique na confirmação errada e a fila some). C põe mais um botão numa barra que já tem bastante coisa, para um ganho pequeno sobre A, porque "Limpar" fica a um clique de distância.

Efeito colateral de A: a Central e o Forgia só ficam sabendo que um item caiu quando o usuário limpa, não no Stop.

## Decisão (2026-10-09)

O usuário escolheu a leitura **A**: Stop nunca descarta a fila.

- Stop para o turno (desfecho `interrompido`, sem retentativa) e deixa a fila da conversa **pausada**, com "Continuar" (despacha o próximo item) e "Limpar" (descarta e avisa Central e Forgia, como o Stop faz hoje).
- Mensagem nova digitada depois do Stop sai na hora (o usuário está no controle), e a fila continua pausada até ele clicar em "Continuar".
- Central e Forgia só são avisadas da queda quando o usuário limpa, não no Stop.
- No celular, o "Cancelar" da recuperação (`recoveryAction: 'cancel'`) também só pausa.
- **Não muda:** o "não era aqui" da Central (`keepQueue` + `releaseKeptQueue`) continua soltando a fila sozinho. Lá a mensagem parada estava na conversa errada, então a fila dela segue normal.

Detalhes em [[Stop pausa a fila, nunca descarta]].
