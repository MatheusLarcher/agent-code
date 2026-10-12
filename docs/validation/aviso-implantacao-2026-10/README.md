# Validação do aviso de implantação — app real, instância isolada (11/10/2026)

Correção: `implantacaoEmCurso` (`src/main/handoffTracking/projectQueueService.ts:172`) passou de
`!!views[0]?.started` para "o plano da vez está `rodando` ou `entre_prompts`". O aviso
"Uma implantação está rodando neste projeto — mexer nos mesmos arquivos mistura as mudanças." continua
existindo; só deixa de aparecer na conversa avulsa quando o plano da vez está parado.

Instância isolada (`AGENT_CODE_DEV_DATA_DIR` em `%TEMP%\aviso-val-1791756831826`, sem tocar no app instalado
nem em `%APPDATA%\agent-code-desktop`), build `out/` refeito com `electron-vite build`. Projeto descartável
`avisoproj` com um plano de 1 prompt (`[espera]`: o agente roda `node espera.js`, 5 min, em primeiro plano).
Conversa do plano `cmv4drgblm5q0x` — "Implementação: Validação do aviso"; a avulsa é uma "Nova conversa" da
mesma pasta, criada pela ponte. PO, Scrum Master, vigia, memorista e typesafe desligados na instância.
Roteiro: `validar-aviso.mjs`. Saída: `execucao.log`, `resultado.json` (cada checagem com o texto do aviso, a
conversa ativa e a foto da fila que o renderer recebe).

| # | Cenário | Resultado | Evidência |
|---|---------|-----------|-----------|
| 1a | Plano da vez **rodando** (turno ativo) — avulsa da pasta mostra o aviso | OK | `01-rodando-a-avulsa.png`; fila `implantacaoEmCurso: true`, `Validação do aviso:rodando` |
| 1b | Rodando — sair da avulsa (para a conversa do plano) e voltar | OK (aviso aparece) | `01-rodando-b-voltou.png` |
| 1c | Rodando — F5 e abrir a avulsa de novo | OK (aviso aparece) | `01-rodando-c-f5.png` |
| 2a | Plano da vez **parado** (Stop no turno) — avulsa da pasta sem aviso | OK | `02-parado-a-avulsa.png`; fila `implantacaoEmCurso: false`, `Validação do aviso:parado` |
| 2b | Parado — sair e voltar à avulsa | OK (sem aviso) | `02-parado-b-voltou.png` |
| 2c | Parado — F5 e abrir a avulsa de novo | OK (sem aviso) | `02-parado-c-f5.png` |

Resultado: 6/6 OK (`execucao.log`, "fim: 6/6 OK").

**Testes unitários** (red-green feito com a linha antiga: o assert do parado falhava com
"expected true to be false"):

- `src/main/handoffTracking/projectQueueService.test.ts` — no teste "em execução com o turno vivo → rodando…
  parado": `implantacaoEmCurso` é `true` rodando e `false` parado;
- `src/renderer/src/planning/projectQueue.test.tsx` — avulsa sem aviso com o plano parado ou só na fila;
  aviso com o plano `rodando` e `entre_prompts`; outra pasta sem aviso.

**Olhe isto**

- A 1ª rodada deu 3 falhas falsas: o roteiro clicava na "Nova conversa" do Sandbox (a 1ª da barra), não na da
  pasta `avisoproj`. O seletor foi restrito ao grupo do projeto; a rodada 2 (esta) é a que vale.
- O Stop levou o plano a `parado` logo em seguida (~3 s), sem esperar os 3 min sem turno.
- `03-parado-conversa-do-plano.png`: a conversa do próprio plano parado, sem outro plano na fila, também fica
  sem aviso — comportamento de `planNotice`, que esta correção não toca.
- `entre_prompts` foi validado só no teste unitário (no app real o intervalo entre prompts dura segundos).
