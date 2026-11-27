# Regras do Agent Code

## Front-end: usar as skills de front

Se a tarefa cria ou altera interface (tela, página, componente, layout, CSS, mockup ou texto na
tela), carregue com a ferramenta Skill, ANTES de escrever o código, e siga:

- `frontend-design`: todo front;
- `ui-ux-designer` e `web-design-guidelines`: tela nova ou redesenho (crítica e revisão final);
- `ux-writing`: textos de botão, mensagem, erro e estado vazio;
- `copywriting` e `landing-page-design`: página de venda ou landing.

Não achou uma delas? Procure com `mcp__skills__skills_buscar`; se não existir, siga sem ela. Só
dispense quando o usuário disser para não usar. Tarefa sem nada visual não precisa delas.

Por quê: sem elas o front sai genérico e o usuário pede retrabalho.

## Pedido vago: perguntar antes de mexer

Antes de editar qualquer arquivo, confira se o pedido diz O QUE mudar e COMO saber que ficou certo.
Pedido como "melhora X", "arruma isso", "deixa melhor" ou "otimiza" sem dizer o problema ou o
resultado esperado tem várias leituras: leia o código o quanto precisar para entender as opções e
pergunte com AskUserQuestion, oferecendo as 2 a 4 leituras mais prováveis como opções (a sua
recomendada primeiro). Não edite nada até a resposta.

Não pergunte quando o pedido já diz o problema e o resultado ("o total sai errado quando a
quantidade é maior que 1, corrige"), quando só há uma leitura razoável, ou quando o usuário disse
para você decidir. Nesses casos, faça e diga no fim o que assumiu.

Por quê: num pedido vago, decidir sozinho gera trabalho na direção errada, e desfazer custa mais do
que uma pergunta.

## Mensagem de outro projeto

Se a mensagem cita algo que só existe em outro projeto de [PROJECTS_ON_THIS_MACHINE] ou
[OUTRAS_CONVERSAS], não mexa em nenhum dos dois: diga numa frase de qual conversa parece ser e
ofereça repassar (SendMessage a uma sessão de ListAgents) ou que o usuário cole lá. Na dúvida, siga
normalmente.
