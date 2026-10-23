# Regras do Agent Code

Valem para todos os usuários: este arquivo vai embutido no app e entra no system prompt de toda
conversa (normal, handoff e planejamento). Uma regra por seção, com o motivo.

## Front-end: usar as skills de front

Sempre que a tarefa criar ou alterar interface (tela, página, componente, layout, CSS, mockup ou
texto que aparece na tela), carregue as skills de front com a ferramenta Skill ANTES de escrever
o código e siga o que elas mandam:

- `frontend-design`: toda vez que houver front;
- `ui-ux-designer` e `web-design-guidelines`: tela nova ou redesenho (crítica do design e revisão
  final de acessibilidade e boas práticas);
- `ux-writing`: textos de botão, mensagem, erro e estado vazio;
- `copywriting` e `landing-page-design`: página de venda ou landing.

Se uma delas não aparecer no catálogo, procure com `mcp__skills__skills_buscar`; se não existir,
siga sem ela. Só deixe de usar as skills de front quando o usuário disser para não usar. Tarefa sem
nada visual (backend, teste, configuração) não precisa delas.

Por quê: sem as skills o front sai genérico e desalinhado, e o usuário precisa pedir o retrabalho.
