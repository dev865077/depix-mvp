# Wiki 2.0 Review Mirror

Esta pasta e o espelho reviewavel da `Wiki 2.0` do projeto.

Se a GitHub Wiki nao estiver habilitada para a visibilidade ou plano atual do repositorio, esta pasta continua como fonte de verdade documental.

## Por que ela existe

O GitHub Wiki e um repositorio Git separado e nao oferece um fluxo normal de `Issues` e `Pull Requests` como o repositorio principal. Por isso, esta pasta permite:

- revisar o conteudo da nova wiki em PR normal
- discutir estrutura, texto e navegacao antes da publicacao
- sincronizar depois o conteudo aprovado para a wiki real

## Fontes e padroes usados

Esta proposta se apoia em quatro referencias principais:

- GitHub Docs: wikis podem ser editadas localmente como repositorio Git
- GitHub Docs: `_Sidebar` e `_Footer` sao mecanismos oficiais de navegacao persistente
- `jgraph/drawio` wiki: boa home enxuta com caminhos de leitura por assunto
- `gollum/gollum` wiki: wiki como base documental organizada por pagina e navegacao lateral

## O que muda na Wiki 2.0

- Home mais clara e mais executiva
- leitura inicial guiada por publico e por necessidade
- mapa tecnico mais alinhado ao estado real do `main`
- navegacao lateral mais forte
- footer fixo com fonte de verdade e caminho de manutencao
- pagina nova de `Roadmap e Backlog`
- linguagem mais consistente entre produto, arquitetura, engenharia e operacao
- atualizacao automatica da pasta `docs/wiki` apos merge de PR, com publicacao da wiki real so quando ela estiver habilitada
- a suite de review de PR passou a manter um matrix de regressao canonico para o contrato de blocker e para a reconciliacao de follow-up

## Paginas

- [Home.md](./Home.md)
- [Leitura-Inicial.md](./Leitura-Inicial.md)
- [Visao-Geral-do-Produto.md](./Visao-Geral-do-Produto.md)
- [Escopo-e-Fluxo.md](./Escopo-e-Fluxo.md)
- [Roadmap-e-Backlog.md](./Roadmap-e-Backlog.md)
- [Arquitetura-Geral.md](./Arquitetura-Geral.md)
- [Tenancy-e-Roteamento.md](./Tenancy-e-Roteamento.md)
- [Modelo-de-Dados.md](./Modelo-de-Dados.md)
- [XState-e-Fluxo-de-Pedidos.md](./XState-e-Fluxo-de-Pedidos.md)
- [Integracoes-Externas.md](./Integracoes-Externas.md)
- [Estrutura-do-Repositorio.md](./Estrutura-do-Repositorio.md)
- [Contribuicao-e-PRs.md](./Contribuicao-e-PRs.md)
- [Testes-e-Qualidade.md](./Testes-e-Qualidade.md)
- [Ambientes-e-Segredos.md](./Ambientes-e-Segredos.md)
- [Deploy-e-Runbooks.md](./Deploy-e-Runbooks.md)
- [Teste-Humano-MVP.md](./Teste-Humano-MVP.md)
- [Governanca-Tecnica.md](./Governanca-Tecnica.md)
- [ADRs.md](./ADRs.md)
- [Wiki-Inicial.md](./Wiki-Inicial.md)
- [_Sidebar.md](./_Sidebar.md)
- [_Footer.md](./_Footer.md)

## Publicacao depois da PR

Depois da aprovacao:

1. sincronizar esta pasta com `depix-mvp.wiki.git` quando a GitHub Wiki estiver habilitada
2. publicar no branch default da wiki quando a GitHub Wiki estiver habilitada
3. validar links, sidebar e footer na wiki real quando ela existir
4. manter a sincronizacao automatica via workflow de atualizacao da wiki quando um PR for mergeado
