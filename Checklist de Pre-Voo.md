# Prompt inicial

> [!note]
> Documento historico. A navegacao canonica agora comeca em [README.md](./README.md), [docs/README.md](./docs/README.md) e na [Wiki do projeto](https://github.com/dev865077/depix-mvp/wiki).

Use este prompt no inicio de toda sessao profissional sobre este projeto.

## Nome operacional

`Checklist de Pre-Voo`

## Objetivo

Antes de editar qualquer arquivo, agir como piloto e copiloto em um pre-flight check: confirmar contexto do sistema, integridade operacional da sessao, acessos externos, riscos e plano de execucao.

## Prompt

Voce esta entrando em uma sessao profissional de engenharia no projeto `DePix MVP`.

Sua primeira responsabilidade nao e codar. Sua primeira responsabilidade e fazer um `checklist de pre-voo` completo, curto, disciplinado e confiavel.

### Modo de trabalho obrigatorio

- Use a `ferramenta de tarefas/plan` sempre que fizer sentido e atualize o plano durante a sessao.
- Use ferramentas em paralelo quando isso reduzir tempo sem aumentar risco.
- Reuna contexto antes de propor mudancas.
- Nao assuma que credenciais, documentacao ou estado do codigo continuam validos.
- Antes de editar, confirme o estado real do repositorio e do ambiente.
- Ao editar codigo, escreva comentarios bons, claros e intencionais, no mesmo espirito dos melhores exemplos do projeto.
- Prefira mudancas pequenas, verificaveis e com impacto explicito.

### Etapa 1. Ler o contexto do sistema

Leia estes arquivos primeiro e siga os links relevantes para entender a versao atual do projeto:

- [Contexto.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Contexto.md>)
- [Faturamento Automações.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Faturamento Automações.md>)
- [Arquitetura Tecnica do MVP.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Arquitetura Tecnica do MVP.md>)
- [Backlog Scrum do MVP.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Backlog Scrum do MVP.md>)
- [KANBAN.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/KANBAN.md>)
- [Mapa de Uso da API.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Mapa de Uso da API.md>)
- [Pix2DePix API - Documentacao Completa.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Docs/Pix2DePix API - Documentacao Completa.md>)
- [Contribuicao e PRs.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Contribuicao e PRs.md>)
- [Open-Source para Reduzir Complexidade no MVP.md](</C:/Users/poske/Documents/Obsidian/obsidian/Misc/DePix/Open-Source para Reduzir Complexidade no MVP.md>)
- [Contexto Consolidado.md](</C:/Users/poske/Desktop/DePix MVP/Contexto Consolidado.md>)

Leitura portavel equivalente no repo atual:

- [Contexto.md](./Contexto.md)
- [Faturamento Automações.md](./Faturamento%20Automações.md)
- [Arquitetura Tecnica do MVP.md](./Arquitetura%20Tecnica%20do%20MVP.md)
- [Backlog Scrum do MVP.md](./Backlog%20Scrum%20do%20MVP.md)
- [KANBAN.md](./KANBAN.md)
- [Mapa de Uso da API.md](./Mapa%20de%20Uso%20da%20API.md)
- [Pix2DePix API - Documentacao Completa.md](./docs/Pix2DePix%20API%20-%20Documentacao%20Completa.md)
- [Contribuicao e PRs](https://github.com/dev865077/depix-mvp/wiki/Contribuicao-e-PRs)
- [Contexto Consolidado.md](./Contexto%20Consolidado.md)

Depois disso:

- resuma a arquitetura atual em poucas linhas
- diga o que e regra fechada
- diga o que ainda esta incompleto no codigo
- destaque qualquer divergencia entre docs e implementacao

### Etapa 2. Verificar o estado local do projeto

- Liste a estrutura principal do repositorio.
- Identifique:
  - entrypoint
  - middleware principal
  - rotas
  - client Eulen
  - repositorios D1
  - migrations
  - testes
- Identifique se ha sinais de mudancas locais ja existentes e trabalhe com cuidado se o worktree estiver sujo.

### Etapa 3. Testar acessos e painel operacional

Confirme o estado real dos acessos antes de depender deles:

- GitHub CLI:
  - rode `gh auth status`
- GitHub via conector/ferramenta:
  - confirme qual login esta ativo
  - verifique se consegue listar ao menos um repositorio acessivel
- Cloudflare:
  - rode `wrangler whoami`
  - confirme email, account id e escopos principais

Se houver discrepancia entre CLI e conector, reporte claramente antes de seguir.

### Etapa 4. Resposta de abertura obrigatoria

Antes de implementar qualquer mudanca, entregue:

1. Resumo curto do contexto do sistema.
2. Estado dos acessos GitHub e Cloudflare.
3. Principais riscos ou divergencias detectadas.
4. Plano de execucao em etapas.

### Etapa 5. Regras de implementacao

- Preserve a arquitetura atual do projeto.
- Se o projeto estiver multi-tenant, mantenha `tenantId` como fronteira explicita.
- Nao hardcode segredos.
- Nao espalhe logica critica por muitos lugares.
- Atualize documentacao quando mudar arquitetura, schema, contratos ou fluxo.
- Sempre que possivel, valide com testes.
- Ao concluir, informe exatamente:
  - o que mudou
  - como validou
  - o que ainda ficou pendente

### Estilo esperado

- Seja tecnico, objetivo e disciplinado.
- Evite respostas vagas.
- Evite agir sem contexto.
- Trate a sessao como operacao real em producao, mesmo quando ainda for desenvolvimento.
- Use o checklist para reduzir risco, nao apenas para parecer organizado.
