# Curadoria das skills do ECC — 09/10/2026

Fonte: https://github.com/affaan-m/ECC (licença MIT), commit `ef648e01899ba3e8dc6371642deaaf64b4477775` (01/10/2026), pasta `skills/` — 293 skills.
Destino das aprovadas: `.agents/skills-ecc/<nome>/` (kit embutido, vai no instalador), com o `LICENSE` do ECC em cada pasta e a entrada em `skills-lock.json` (`source: "affaan-m/ECC"`).
Elas só aparecem com o interruptor **"Catálogo de skills em níveis"** ligado; desligado, o app fica como antes. As duas do ciclo (`verification-loop`, `agent-self-evaluation`) seguem o interruptor do ciclo.

**Resumo:** 179 instaladas · 93 puladas · 19 perderam para a skill atual · 2 já no kit do ciclo. Nenhuma skill do usuário foi alterada ou sobrescrita.

## Como foi decidido

1. **Inventário automático** (só leitura) das 293 pastas: descrição, tamanho, arquivos, scripts, referências à infraestrutura do ECC, padrões perigosos em scripts e choque de nome com as skills do usuário.
2. **Leitura integral** em quatro frentes: (a) comparação com as skills do usuário pelo roteiro fixo — instruções concretas e verificáveis, exemplos, casos do dia a dia, não contradiz as regras dele; empate fica a atual; (b) auditoria de todos os scripts (20 skills, mais os `.lua` da video-editing); (c) skills que citam a infraestrutura do ECC, ferramentas externas ou parecem rascunho.
3. **Regra:** fora as que dependem do ECC (hooks, agentes, comandos, CLI, pastas), as presas a serviço/MCP pago ou externo que o usuário não usa, os rascunhos e as com script inseguro. Tema já coberto: a do ECC só entra se for claramente melhor; na dúvida, fica a do usuário. Tema novo (inclusive domínios que o usuário ainda não usa, com ferramentas livres): entra.
4. **Nível:** toda skill do ECC entra como **baixa** (só o nome, por categoria). Crítica é só `verification-before-completion`. Média = as skills do usuário usadas nos últimos 90 dias (Skill tool, /comando ou leitura do SKILL.md, medido em 4.479 transcripts) e as que o ciclo do handoff cita. Skill nova que aparecer depois entra como média até ser classificada. O nível e a categoria de cada skill podem ser trocados em Configurações.

## Skills do ECC

| # | skill | veredito | motivo | nível | categoria |
|---|---|---|---|---|---|
| 1 | accessibility | perdeu para a atual | Perdeu para web-design-guidelines: metade SwiftUI/Compose; frontend-a11y cobre React melhor. | — | Frontend |
| 2 | agent-architecture-audit | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 3 | agent-eval | pulada | Ferramenta externa: exige o CLI agent-eval. | — | Planejamento e processo |
| 4 | agent-harness-construction | pulada | Rascunho: só princípios, sem passos nem exemplos verificáveis. | — | Planejamento e processo |
| 5 | agent-introspection-debugging | instalada | Depura falhas de execução de agente, não bugs de código. | baixa | Planejamento e processo |
| 6 | agent-payment-x402 | pulada | Ferramenta externa: carteira cripto (agentwallet-sdk/OKX). | — | Outras |
| 7 | agent-self-evaluation | já no kit do ciclo | Já está no kit do ciclo (.agents/skills-ciclo), que segue o interruptor do ciclo. | — | Planejamento e processo |
| 8 | agent-sort | pulada | Infra ECC: monta plano de instalação do ECC. | — | Planejamento e processo |
| 9 | agentic-engineering | pulada | Rascunho: lista genérica sem procedimento. | — | Planejamento e processo |
| 10 | agentic-os | instalada | Estrutura com templates; agendamento por SO. | baixa | Planejamento e processo |
| 11 | ai-first-engineering | pulada | Rascunho: diretrizes sem passos nem critérios. | — | Planejamento e processo |
| 12 | ai-regression-testing | perdeu para a atual | Perdeu para test-driven-development: centrada em Supabase/Next e contraditória. | — | Testes e qualidade |
| 13 | android-clean-architecture | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 14 | angular-developer | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 15 | api-connector-builder | instalada | Fluxo concreto para nova integração no padrão do repositório. | baixa | Backend |
| 16 | api-design | perdeu para a atual | Perdeu para api-design do usuário: a dele é do stack NestJS/ERP; a do ECC é genérica. | — | Backend |
| 17 | architecture-decision-records | instalada | Registro de ADR com consentimento antes de criar arquivos. | baixa | Planejamento e processo |
| 18 | article-writing | instalada | Conteúdo longo, distinto de copy de conversão. | baixa | Documentos |
| 19 | automation-audit-ops | pulada | Infra ECC: saída é o "NEXT ECC MOVE" e puxa skills do ECC. | — | Planejamento e processo |
| 20 | autonomous-agent-harness | instalada | Setup concreto com /loop, claude -p e agendador do SO. | baixa | Planejamento e processo |
| 21 | autonomous-loops | pulada | Obsoleta: "retained for compatibility only"; o NanoClaw exige scripts/claw.js do ECC. | — | Planejamento e processo |
| 22 | backend-patterns | perdeu para a atual | Perdeu para nestjs-patterns/api-design: exemplos Supabase/Express fora do stack. | — | Backend |
| 23 | benchmark | perdeu para a atual | Rascunho perto da performance-check: diz o que medir sem dizer como; grava baselines em .ecc/. | — | Testes e qualidade |
| 24 | benchmark-methodology | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 25 | benchmark-optimization-loop | instalada | Método de otimização medida com gate de correção, ausente na performance-check. | baixa | Testes e qualidade |
| 26 | blender-motion-state-inspection | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Vídeo e mídia |
| 27 | blueprint | pulada | Rascunho: o checklist da revisão não está no arquivo; depende de /blueprint. | — | Planejamento e processo |
| 28 | brand-discovery | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 29 | brand-voice | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 30 | browser-qa | instalada | Roteiro de QA no app rodando (console, rede, breakpoints, axe), alinhado a testar de verdade. | baixa | Testes e qualidade |
| 31 | bun-runtime | instalada | Comandos e exemplos concretos de Bun. | baixa | Backend |
| 32 | canary-watch | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 33 | carrier-relationship-management | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 34 | cisco-ios-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 35 | ck | pulada | Hook SessionStart e grava em ~/.claude/projects/<proj>/memory — conflita com a memória do app. | — | Planejamento e processo |
| 36 | claude-devfleet | pulada | Ferramenta externa: servidor DevFleet via MCP. | — | Planejamento e processo |
| 37 | click-path-audit | instalada | Recomendada: rastreia handlers e efeitos em stores quando o debugging não acha a causa; complementa systematic-debugging. | baixa | Depuração |
| 38 | clickhouse-io | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Banco de dados |
| 39 | code-tour | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 40 | codebase-onboarding | perdeu para a atual | Perdeu para graphify (e o /init embutido). | — | Planejamento e processo |
| 41 | codehealth-mcp | pulada | Ferramenta externa: CodeScene MCP com token. | — | Testes e qualidade |
| 42 | coding-standards | perdeu para a atual | Perdeu para component-review: envelope {success,data,error} conflita com o api-design do ERP. | — | Testes e qualidade |
| 43 | competitive-platform-analysis | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 44 | competitive-report-structure | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 45 | compose-multiplatform-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 46 | config-gc | pulada | Apaga itens de ~/.claude (skills, memória): conflita com as skills e a memória que o Agent Code gerencia e recria. | — | Planejamento e processo |
| 47 | configure-ecc | pulada | Infra ECC: assistente de instalação do ECC (ecc setup). | — | Planejamento e processo |
| 48 | connections-optimizer | pulada | Ferramenta externa: grafo do X/LinkedIn, Exa e Apple Mail. | — | Documentos |
| 49 | content-engine | instalada | Conteúdo nativo de plataforma e repurposing. | baixa | Documentos |
| 50 | content-hash-cache-pattern | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 51 | context-budget | instalada | Inventário de contexto com heurísticas e relatório. | baixa | Planejamento e processo |
| 52 | continuous-agent-loop | pulada | Infra ECC: só encaminha para pipelines e comandos do ECC. | — | Planejamento e processo |
| 53 | continuous-learning | pulada | Obsoleta (deprecated) e presa a hook de Stop do ECC. | — | Planejamento e processo |
| 54 | continuous-learning-v2 | pulada | Infra ECC + insegura: grava entrada/saída de toda ferramenta e roda claude em segundo plano sem pedir permissão. Decisão do plano: não entra. | — | Planejamento e processo |
| 55 | contract-first | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 56 | cost-aware-llm-pipeline | instalada | Custo de API de LLM (roteamento, budget, cache); cost-reducer cobre cloud. | baixa | Backend |
| 57 | cost-tracking | pulada | Lê o log do hook stop:cost-tracker do ECC. | — | Planejamento e processo |
| 58 | council | instalada | Decisão sob ambiguidade (go/no-go); não é code review. | baixa | Planejamento e processo |
| 59 | council-multi-model | pulada | Ferramenta externa: Codex 0.146.0 exato + envio à OpenAI; exige o council. | — | Planejamento e processo |
| 60 | counterparty-channel-discipline | pulada | Ferramenta externa: exige um runtime de mensageria com canais compartilhados. | — | Planejamento e processo |
| 61 | cpp-coding-standards | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 62 | cpp-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 63 | crosspost | instalada | Regras por plataforma e quality gate. | baixa | Documentos |
| 64 | csharp-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 65 | customer-billing-ops | pulada | Ferramenta externa: Stripe. | — | Regras de negócio (ERP) |
| 66 | customs-trade-compliance | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 67 | dart-flutter-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 68 | dashboard-builder | pulada | Ferramenta externa: Grafana/SigNoz. | — | Backend |
| 69 | data-scraper-agent | pulada | Ferramenta externa: Gemini + Notion/Sheets/Supabase. | — | Python |
| 70 | data-throughput-accelerator | instalada | Workflow de 7 passos com contabilidade verificável. | baixa | Backend |
| 71 | database-migrations | perdeu para a atual | Perdeu para typeorm-migration: a do usuário tem os comandos TypeORM do stack. | — | Banco de dados |
| 72 | deep-research | pulada | Ferramenta externa: Firecrawl/Exa MCP. | — | Planejamento e processo |
| 73 | defi-amm-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 74 | delivery-gate | pulada | Hook de Stop preso às pastas do ECC; bloqueia todo fim de turno com <15 GB livres. Decisão do plano: não entra. | — | Planejamento e processo |
| 75 | deployment-patterns | instalada | CI/CD, rollback e validação de ambiente; sem equivalente. | baixa | Backend |
| 76 | design-system | perdeu para a atual | Perdeu para frontend-design: notas sem rubrica, comandos inexistentes, gera arquivos sem pedido. | — | Frontend |
| 77 | dev-team | instalada | Revisão multi-persona de design; escopo distinto da adversarial-review. | baixa | Planejamento e processo |
| 78 | django-celery | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 79 | django-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 80 | django-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 81 | django-tdd | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 82 | django-verification | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 83 | dmux-workflows | pulada | Ferramenta externa: dmux/tmux (não roda no Windows). | — | Planejamento e processo |
| 84 | docker-patterns | instalada | Dockerfile/Compose concretos; a seção do harness do ECC não se aplica. | baixa | Backend |
| 85 | documentation-lookup | pulada | Ferramenta externa: Context7 MCP. | — | Planejamento e processo |
| 86 | dotnet-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 87 | dynamic-workflow-mode | instalada | Árvore de decisão e templates de harness. | baixa | Planejamento e processo |
| 88 | e2e-testing | instalada | Suítes Playwright (POM, CI, flaky) que nenhuma atual cobre. | baixa | Testes e qualidade |
| 89 | ecc-guide | pulada | Infra ECC: responde sobre o repositório do ECC. | — | Planejamento e processo |
| 90 | ecc-recipes | pulada | Infra ECC: mapeia fluxos para comandos do ECC. | — | Planejamento e processo |
| 91 | ecc-tools-cost-audit | pulada | Infra ECC: auditoria do repositório ECC-Tools. | — | Planejamento e processo |
| 92 | email-ops | instalada | Triagem e envio com prova na pasta Enviados; funciona com webmail no navegador. | baixa | Planejamento e processo |
| 93 | energy-procurement | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 94 | enterprise-agent-ops | pulada | Rascunho: só listas, sem procedimento. | — | Planejamento e processo |
| 95 | error-handling | instalada | Padrões de erro tipado, retry, circuit breaker; nenhuma atual cobre. | baixa | Backend |
| 96 | esign-field-placement | pulada | Ferramenta externa: compositor de assinatura web logado; o executável é ilustrativo. | — | Documentos |
| 97 | eval-harness | instalada | Templates de eval e graders usáveis soltos; os comandos do ECC são acessórios. | baixa | Planejamento e processo |
| 98 | evm-token-decimals | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 99 | exa-search | pulada | Ferramenta externa: Exa MCP com EXA_API_KEY. | — | Planejamento e processo |
| 100 | fal-ai-media | pulada | Ferramenta externa paga: fal.ai. | — | Vídeo e mídia |
| 101 | fastapi-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 102 | finance-billing-ops | pulada | Ferramenta externa: dados ao vivo do Stripe. | — | Regras de negócio (ERP) |
| 103 | flox-environments | pulada | Ferramenta externa: Flox/Nix, só macOS/Linux. | — | Backend |
| 104 | flutter-dart-code-review | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 105 | foundation-models-on-device | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 106 | frontend-a11y | instalada | Padrões de acessibilidade React para construir; a atual só audita. | baixa | Frontend |
| 107 | frontend-design-direction | perdeu para a atual | Perdeu para frontend-design: menos concreta e sem exemplos. | — | Frontend |
| 108 | frontend-patterns | perdeu para a atual | Perdeu para component-review: datada e contra "sem overengineering"; react-patterns cobre melhor. | — | Frontend |
| 109 | frontend-slides | pulada | Insegura: export-pdf.sh roda npm install playwright sem versão fixa e npx playwright install na hora. | — | Documentos |
| 110 | fsharp-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 111 | gan-style-harness | pulada | Infra ECC: usa /project:gan-build e scripts/gan-harness.sh do ECC. | — | Planejamento e processo |
| 112 | gateguard | pulada | Hook PreToolUse do ECC (gateguard-fact-force.js). | — | Planejamento e processo |
| 113 | generating-python-installer | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 114 | git-workflow | instalada | Branching, rebase e conflitos; em mensagem de commit, git-commit do usuário continua valendo. | baixa | Planejamento e processo |
| 115 | github-ops | instalada | Triagem, PRs, CI e releases com gh. | baixa | Planejamento e processo |
| 116 | golang-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 117 | golang-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 118 | google-workspace-ops | pulada | Ferramenta externa: conectores do Google Workspace, que o app não tem. | — | Planejamento e processo |
| 119 | growth-log | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 120 | healthcare-cdss-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 121 | healthcare-emr-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 122 | healthcare-eval-harness | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 123 | healthcare-phi-compliance | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 124 | hermes-imports | pulada | Ferramenta externa: Hermes. | — | Planejamento e processo |
| 125 | hexagonal-architecture | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 126 | hipaa-compliance | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 127 | homelab-network-readiness | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 128 | homelab-network-setup | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 129 | homelab-pihole-dns | pulada | Exige Pi-hole num host Linux/Raspberry. | — | Outras |
| 130 | homelab-vlan-segmentation | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 131 | homelab-wireguard-vpn | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 132 | hookify-rules | pulada | Depende do plugin hookify (regras de hook). | — | Planejamento e processo |
| 133 | i18n-sync | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 134 | inherit-legacy-style | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 135 | intent-driven-development | instalada | Critérios de aceite verificáveis para mudanças sensíveis. | baixa | Planejamento e processo |
| 136 | inventory-demand-planning | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 137 | investor-materials | instalada | Roteiro de deck e quality gate. | baixa | Documentos |
| 138 | investor-outreach | instalada | Estrutura e cadência de outreach com quality gate. | baixa | Documentos |
| 139 | ios-icon-gen | pulada | Só macOS (sips) + API Iconify. | — | Mobile |
| 140 | iterative-retrieval | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 141 | ito-baskets | pulada | Ferramenta externa: API da Itô. | — | Outras |
| 142 | ito-compute | pulada | Ferramenta externa: CLI/MCP da Itô. | — | Outras |
| 143 | ito-inference | pulada | Ferramenta externa (Itô) e esqueleto: "unavailable today". | — | Outras |
| 144 | ito-training | pulada | Ferramenta externa (Itô) e esqueleto: "unavailable today". | — | Outras |
| 145 | java-coding-standards | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 146 | jira-integration | pulada | Ferramenta externa: Jira (mcp-atlassian/token). | — | Planejamento e processo |
| 147 | jpa-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Banco de dados |
| 148 | knowledge-ops | instalada | Classificar, deduplicar, armazenar e indexar; integrações opcionais. | baixa | Planejamento e processo |
| 149 | kotlin-coroutines-flows | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 150 | kotlin-exposed-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Banco de dados |
| 151 | kotlin-ktor-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 152 | kotlin-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 153 | kotlin-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 154 | kubernetes-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 155 | laravel-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 156 | laravel-plugin-discovery | pulada | Ferramenta externa: LaraPlugins MCP. | — | Backend |
| 157 | laravel-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 158 | laravel-tdd | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 159 | laravel-verification | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 160 | latency-critical-systems | instalada | Métricas p50/p95/p99 e ordem de otimização concretas. | baixa | Backend |
| 161 | lead-intelligence | pulada | Ferramenta externa: Exa MCP e X API obrigatórios. | — | Documentos |
| 162 | liquid-glass-design | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 163 | living-docs-governance | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 164 | llm-trading-agent-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 165 | logistics-exception-management | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 166 | loop-design-check | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 167 | mailtrap-email-integration | pulada | Ferramenta externa: API do Mailtrap. | — | Backend |
| 168 | make-interfaces-feel-better | perdeu para a atual | Disputa o pedido "melhorar a tela" com frontend-design/web-design-guidelines; na dúvida fica a do usuário. | — | Frontend |
| 169 | manim-video | instalada | Explicadores animados em Manim; script é só uma cena, sem rede. | baixa | Vídeo e mídia |
| 170 | market-research | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 171 | marketing-campaign | instalada | Orquestração de campanha multicanal. | baixa | Documentos |
| 172 | master-agreement-generator | instalada | Template + JSON com pandoc; script local e seguro. | baixa | Documentos |
| 173 | mcp-server-patterns | instalada | Servidores MCP (Node/TS SDK); nenhuma atual cobre. | baixa | Backend |
| 174 | messages-ops | pulada | Ferramenta externa: iMessage/DMs, sem caminho no Windows. | — | Planejamento e processo |
| 175 | ml-adoption-playbook | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 176 | mle-workflow | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 177 | motion-advanced | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 178 | motion-foundations | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 179 | motion-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 180 | mysql-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Banco de dados |
| 181 | nanoclaw-repl | pulada | Infra ECC: REPL scripts/claw.js do ECC. | — | Planejamento e processo |
| 182 | nasiko-control-plane | pulada | Infra ECC: opera via ecc nasiko. | — | Planejamento e processo |
| 183 | nestjs-patterns | perdeu para a atual | Perdeu para nestjs-patterns do usuário: a dele tem as convenções exatas do ERP (roles, TypeORM, migrations). | — | Backend |
| 184 | netmiko-ssh-automation | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 185 | network-bgp-diagnostics | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 186 | network-config-validation | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 187 | network-interface-health | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 188 | nextjs-turbopack | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 189 | nodejs-keccak256 | instalada | Regra e exemplos concretos (domínio Ethereum). | baixa | Outras |
| 190 | nutrient-document-processing | pulada | Ferramenta externa paga: API comercial Nutrient. | — | Documentos |
| 191 | nuxt4-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 192 | openclaw-persona-forge | pulada | Plataforma externa: OpenClaw. | — | Outras |
| 193 | opensource-pipeline | pulada | Infra ECC: depende dos subagentes opensource-* do ECC. | — | Planejamento e processo |
| 194 | operator-approval-loop | pulada | Exige runtime de mensageria e banco de aprovações próprios. | — | Planejamento e processo |
| 195 | orch-add-feature | pulada | Infra ECC: wrapper do orch-pipeline, que delega a agentes do ECC. | — | Planejamento e processo |
| 196 | orch-build-mvp | pulada | Infra ECC: /gan-build e agentes gan-* do ECC. | — | Planejamento e processo |
| 197 | orch-change-feature | pulada | Infra ECC: wrapper do orch-pipeline. | — | Planejamento e processo |
| 198 | orch-fix-defect | pulada | Infra ECC: wrapper do orch-pipeline; delega a /build-fix do ECC. | — | Planejamento e processo |
| 199 | orch-pipeline | pulada | Infra ECC: delega cada fase a agentes e comandos do ECC. | — | Planejamento e processo |
| 200 | orch-refine-code | pulada | Infra ECC: wrapper do orch-pipeline. | — | Planejamento e processo |
| 201 | parallel-execution-optimizer | instalada | Grafo de lanes e leituras em lote; a atual só despacha subagentes. | baixa | Planejamento e processo |
| 202 | perl-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 203 | perl-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 204 | perl-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 205 | plan-canvas | pulada | Infra ECC: CLI ecc-plan-canvas do pacote ecc-universal. | — | Planejamento e processo |
| 206 | plan-orchestrate | pulada | Infra ECC: gera prompts para /orchestrate com o catálogo do ECC. | — | Planejamento e processo |
| 207 | plankton-code-quality | pulada | Depende de hooks PostToolUse (Plankton). | — | Testes e qualidade |
| 208 | postgres-patterns | perdeu para a atual | Perdeu para database-schema-designer/performance-check: referência genérica Supabase. | — | Banco de dados |
| 209 | prediction-market-oracle-research | instalada | Workflow e contrato de saída concretos. | baixa | Outras |
| 210 | prediction-market-risk-review | instalada | Gates de revisão concretos. | baixa | Segurança |
| 211 | prisma-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Banco de dados |
| 212 | product-capability | perdeu para a atual | Perdeu para brainstorming/writing-plans: cerimônia PRD→SRS com lanes do ECC. | — | Planejamento e processo |
| 213 | product-lens | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Planejamento e processo |
| 214 | production-audit | instalada | Auditoria ship/block com evidência local, sem envio externo. | baixa | Backend |
| 215 | production-scheduling | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 216 | project-flow-ops | pulada | Ferramenta externa: Linear é o núcleo do fluxo. | — | Planejamento e processo |
| 217 | prompt-optimizer | pulada | Infra ECC: casa o pedido com componentes do ECC. | — | Planejamento e processo |
| 218 | python-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 219 | python-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 220 | pytorch-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 221 | quality-nonconformance | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 222 | quarkus-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 223 | quarkus-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 224 | quarkus-tdd | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 225 | quarkus-verification | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 226 | rails-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 227 | ralphinho-rfc-pipeline | pulada | Rascunho: lista estágios sem dizer como executar. | — | Planejamento e processo |
| 228 | react-native-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 229 | react-patterns | instalada | Idiomas React gerais com exemplos; component-review é convenção do ERP. | baixa | Frontend |
| 230 | react-performance | instalada | Catálogo priorizado React/Next com exemplos; performance-check foca TypeORM. | baixa | Frontend |
| 231 | react-testing | instalada | Técnica de teste React (RTL, userEvent, MSW) que o TDD, só processo, não cobre. | baixa | Testes e qualidade |
| 232 | recsys-pipeline-architect | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 233 | recursive-decision-ledger | instalada | Contrato do ledger e loop de rollout concretos. | baixa | Planejamento e processo |
| 234 | redis-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Banco de dados |
| 235 | regex-vs-llm-structured-text | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Python |
| 236 | remotion-video-creation | instalada | Vídeo em React com Remotion; só ativa com código Remotion. | baixa | Vídeo e mídia |
| 237 | repo-scan | pulada | Só instala uma skill externa (bootstrap pointer). | — | Outras |
| 238 | research-ops | pulada | Encaminha para Exa/Firecrawl (exa-search, deep-research). | — | Planejamento e processo |
| 239 | returns-reverse-logistics | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Regras de negócio (ERP) |
| 240 | rules-distill | instalada | ADAPTADA: coleta por Glob/Read nas pastas de skills do app (sem jq), resultado no chat, só propõe regras e o usuário aprova. Decisão do plano. | baixa | Planejamento e processo |
| 241 | rust-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 242 | rust-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 243 | safety-guard | pulada | Depende de hooks PreToolUse; o /safety-guard não existe fora do ECC. | — | Planejamento e processo |
| 244 | santa-method | instalada | Gate de verificação dupla antes de publicar; escopo de shipping. | baixa | Planejamento e processo |
| 245 | scientific-db-pubmed-database | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 246 | scientific-db-uspto-database | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 247 | scientific-pkg-gget | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 248 | scientific-thinking-literature-review | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 249 | scientific-thinking-scholar-evaluation | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Outras |
| 250 | search-first | instalada | Busca antes de construir; usa o Agent general-purpose. | baixa | Planejamento e processo |
| 251 | security-bounty-hunter | perdeu para a atual | Disputa "procurar vulnerabilidades no repositório" com web-security/vulnerability-scanner; na dúvida fica a do usuário. | — | Segurança |
| 252 | security-review | perdeu para a atual | Perdeu para security/web-security: a do usuário é sob medida (Snyk, LGPD, JWT). | — | Segurança |
| 253 | security-scan | pulada | Ferramenta externa: AgentShield (npx ecc-agentshield). | — | Segurança |
| 254 | seo | instalada | SEO técnico (robots, canonical, sitemap, JSON-LD) que copywriting não cobre. | baixa | Frontend |
| 255 | skill-comply | pulada | Insegura: executa comandos de instalação gerados por LLM (runner.py:18-21, 110-119). | — | Planejamento e processo |
| 256 | skill-scout | instalada | Busca skills existentes antes de criar uma; nenhuma atual cobre. | baixa | Planejamento e processo |
| 257 | skill-stocktake | pulada | Infra ECC (observations.jsonl do observador do ECC). Decisão do plano: não entra. | — | Planejamento e processo |
| 258 | social-graph-ranker | pulada | Ferramenta externa: grafo do X/LinkedIn. | — | Documentos |
| 259 | social-publisher | pulada | Ferramenta externa: SocialClaw. | — | Documentos |
| 260 | springboot-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 261 | springboot-security | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Segurança |
| 262 | springboot-tdd | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 263 | springboot-verification | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 264 | strategic-compact | pulada | Hook PreToolUse do ECC (suggest-compact.js). | — | Planejamento e processo |
| 265 | swift-actor-persistence | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 266 | swift-concurrency-6-2 | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 267 | swift-protocol-di-testing | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 268 | swiftui-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Mobile |
| 269 | taste | pulada | Ferramenta externa paga: geração no fal.ai; específica de clipe musical. | — | Vídeo e mídia |
| 270 | taste-application | pulada | Ferramenta externa paga: fal.ai (FAL_KEY), DaVinci. | — | Vídeo e mídia |
| 271 | taste-distillation | pulada | Ferramenta externa paga: fal.ai para a destilação. | — | Vídeo e mídia |
| 272 | tasteforge-video | pulada | Infra ECC: a implementação é o pacote tasteforge do ECC. | — | Vídeo e mídia |
| 273 | tdd-workflow | perdeu para a atual | Comparada no prompt 1 com test-driven-development: manda commitar a cada fase, roda script do ECC e grava relatório em docs/. | — | Testes e qualidade |
| 274 | team-agent-orchestration | instalada | Kanban com critérios de saída e fluxo de 7 passos. | baixa | Planejamento e processo |
| 275 | team-builder | instalada | Despacha agentes em paralelo com a ferramenta Agent e sintetiza. | baixa | Planejamento e processo |
| 276 | terminal-opener | pulada | Só WezTerm. | — | Planejamento e processo |
| 277 | terminal-ops | instalada | Execução com evidência; funciona sem o ECC. | baixa | Planejamento e processo |
| 278 | tinystruct-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Backend |
| 279 | token-budget-advisor | instalada | Estimativa e opções de profundidade de resposta. | baixa | Planejamento e processo |
| 280 | ui-demo | perdeu para a atual | Disputa "vídeo do app" com o brag; na dúvida fica a do usuário. | — | Vídeo e mídia |
| 281 | ui-to-vue | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 282 | uncloud | pulada | Ferramenta externa: CLI uc do Uncloud. | — | Backend |
| 283 | unified-memory | pulada | Infra ECC: ECC Memory Vault (ecc memory). | — | Planejamento e processo |
| 284 | unified-notifications-ops | pulada | Infra ECC: fluxo "ECC-native". | — | Planejamento e processo |
| 285 | verification-loop | já no kit do ciclo | Já está no kit do ciclo (.agents/skills-ciclo), que segue o interruptor do ciclo. | — | Testes e qualidade |
| 286 | video-editing | instalada | Edição de footage real com FFmpeg/Remotion; serviços pagos só na camada opcional. | baixa | Vídeo e mídia |
| 287 | videodb | pulada | Ferramenta externa paga: VideoDB. | — | Vídeo e mídia |
| 288 | visa-doc-translate | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Documentos |
| 289 | vite-patterns | pulada | Escrita para o Vite 8 (rolldownOptions, minify oxc); o agent-code usa o Vite 6 — risco de configuração errada. | — | Frontend |
| 290 | vue-patterns | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Frontend |
| 291 | windows-desktop-e2e | instalada | Tema novo, com instruções e exemplos concretos. | baixa | Testes e qualidade |
| 292 | workspace-surface-audit | pulada | Infra ECC: recomenda componentes do ECC. | — | Planejamento e processo |
| 293 | x-api | pulada | Ferramenta externa: X/Twitter API. | — | Outras |

## Skills do usuário e do ciclo (nível e categoria no índice)

| skill | nível | categoria |
|---|---|---|
| 3d-print-modeling | média | Vídeo e mídia |
| adversarial-review | baixa | Testes e qualidade |
| agent-self-evaluation | média | Planejamento e processo |
| ai-llm-security | baixa | Segurança |
| api-design | baixa | Backend |
| blue-team-defense | baixa | Segurança |
| brag | média | Vídeo e mídia |
| brag-slim | baixa | Vídeo e mídia |
| brainstorming | média | Planejamento e processo |
| browser | baixa | Frontend |
| caveman | média | Planejamento e processo |
| cloud-security | baixa | Segurança |
| code-review | média | Testes e qualidade |
| component-review | baixa | Frontend |
| copywriting | média | Documentos |
| cost-reducer | baixa | Backend |
| crypto-analysis | baixa | Segurança |
| csoc-automation | baixa | Segurança |
| database-schema-designer | baixa | Banco de dados |
| debug-nestjs | baixa | Backend |
| diagnosing-superpowers | baixa | Planejamento e processo |
| dispatching-parallel-agents | baixa | Planejamento e processo |
| economy-mode | baixa | Planejamento e processo |
| executing-plans | média | Planejamento e processo |
| exploit-development | baixa | Segurança |
| financeiro-rules | baixa | Regras de negócio (ERP) |
| finishing-a-development-branch | baixa | Planejamento e processo |
| form-builder | baixa | Frontend |
| frontend-design | média | Frontend |
| git-commit | baixa | Documentos |
| graphify | média | Planejamento e processo |
| grc-compliance | baixa | Segurança |
| hyperframes-cli | média | Vídeo e mídia |
| incident-response | baixa | Segurança |
| landing-page-design | baixa | Frontend |
| log-analysis | baixa | Segurança |
| loop | média | Planejamento e processo |
| malware-analysis | baixa | Segurança |
| matricula-flow | baixa | Regras de negócio (ERP) |
| media-use | baixa | Vídeo e mídia |
| mobile-security | baixa | Segurança |
| nestjs-patterns | baixa | Backend |
| network-security | baixa | Segurança |
| ot-ics-security | baixa | Segurança |
| performance-check | baixa | Testes e qualidade |
| planejar | média | Planejamento e processo |
| purple-team | baixa | Segurança |
| receiving-code-review | baixa | Testes e qualidade |
| recon-osint | baixa | Segurança |
| red-team-ops | baixa | Segurança |
| relatorios | baixa | Documentos |
| requesting-code-review | média | Testes e qualidade |
| reverse-engineering | baixa | Segurança |
| rtk | baixa | Planejamento e processo |
| security | baixa | Segurança |
| skill-builder | baixa | Planejamento e processo |
| subagent-driven-development | média | Planejamento e processo |
| supply-chain-security | baixa | Segurança |
| systematic-debugging | média | Depuração |
| test-driven-development | média | Testes e qualidade |
| threat-hunting | baixa | Segurança |
| threat-intelligence | baixa | Segurança |
| typeorm-migration | baixa | Banco de dados |
| ui-ux-designer | baixa | Frontend |
| using-git-worktrees | baixa | Planejamento e processo |
| using-superpowers | baixa | Planejamento e processo |
| ux-writing | baixa | Frontend |
| verification-before-completion | crítica | Testes e qualidade |
| verification-loop | média | Testes e qualidade |
| vulnerability-scanner | baixa | Segurança |
| web-design-guidelines | baixa | Frontend |
| web-security | baixa | Segurança |
| writing-plans | média | Planejamento e processo |
| writing-skills | baixa | Planejamento e processo |

## Para revisar

- Skills do ERP (matricula-flow, financeiro-rules, nestjs-patterns, typeorm-migration…) ficaram **baixas** porque não aparecem nos transcripts dos últimos 90 dias. Se o ERP voltar a ser o trabalho do dia, suba-as para média em Configurações.
- Discordâncias com a avaliação inicial do Agent Manager, depois da leitura integral: entraram `react-testing`, `browser-qa`, `error-handling` e `mcp-server-patterns` (escopo que nenhuma skill atual cobre); `vite-patterns` ficou fora por outro motivo (escrita para o Vite 8; o agent-code usa o Vite 6). `windows-desktop-e2e` entrou como tema novo (o Manager a descartou por ser de apps nativos).
- `rules-distill` entrou **adaptada**: coleta por Glob/Read nas pastas de skills do app (os scripts originais exigem `jq`, que não existe nesta máquina), resultado no chat e nada gravado sem aprovação.
