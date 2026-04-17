# Documentacao do Projeto

Documentacao institucional e versionada do `depix-mvp`.

Esta arvore organiza o projeto do geral para o especifico e separa quatro coisas que antes estavam misturadas:

- contexto funcional
- arquitetura e integracoes
- engenharia e codigo
- operacao e governanca

## Como navegar

| Bloco | Objetivo | Comecar aqui |
|---|---|---|
| Produto | Entender o que o MVP faz e onde ele termina | [Visao geral do produto](./product/visao-geral.md) |
| Arquitetura | Entender componentes, contratos e dados | [Arquitetura geral](./architecture/arquitetura-geral.md) |
| Engenharia | Entender repositorio, fluxo de mudanca e qualidade | [Estrutura do repositorio](./engineering/estrutura-do-repositorio.md) |
| Operacao | Entender ambientes, secrets e deploy | [Ambientes e segredos](./operations/ambientes-e-segredos.md) |
| Governanca | Entender backlog estrutural e disciplina tecnica | [Governanca tecnica](./governance/governanca-tecnica.md) |

## Ordem de leitura recomendada

1. [Leitura inicial](./getting-started.md)
2. [Visao geral do produto](./product/visao-geral.md)
3. [Escopo e fluxo principal](./product/escopo-e-fluxo.md)
4. [Arquitetura geral](./architecture/arquitetura-geral.md)
5. [Tenancy e roteamento](./architecture/tenancy-e-roteamento.md)
6. [Modelo de dados](./architecture/modelo-de-dados.md)
7. [Estrutura do repositorio](./engineering/estrutura-do-repositorio.md)
8. [Contribuicao e PRs](./engineering/contribuicao-e-prs.md)
9. [Ambientes e segredos](./operations/ambientes-e-segredos.md)

## Estado desta documentacao

Esta arvore passa a ser a camada principal de documentacao do repositorio.

Os markdowns antigos na raiz continuam como fonte historica e de apoio, mas a navegacao canônica agora comeca aqui.

## Referencias tecnicas complementares

- [Cloudflare para o MVP - Free Tier e Arquitetura Simples](./Cloudflare%20para%20o%20MVP%20-%20Free%20Tier%20e%20Arquitetura%20Simples.md)
- [Pix2DePix API - Documentacao Completa](./Pix2DePix%20API%20-%20Documentacao%20Completa.md)
