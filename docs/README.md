# Documentacao Tecnica

Esta pasta e a casa canonica da documentacao tecnica versionada do repositorio.

## Documentos atuais

- [Cloudflare Secrets Store - Runbook.md](./Cloudflare%20Secrets%20Store%20-%20Runbook.md)
- [Cloudflare para o MVP - Free Tier e Arquitetura Simples.md](./Cloudflare%20para%20o%20MVP%20-%20Free%20Tier%20e%20Arquitetura%20Simples.md)
- [debot-extraction-boundary.md](./debot-extraction-boundary.md)
- [financial-api-boundary.md](./financial-api-boundary.md)
- [operations/secrets-and-environment-inventory.md](./operations/secrets-and-environment-inventory.md)
- [operations/split-repo-deploy-verification.md](./operations/split-repo-deploy-verification.md)
- [Pix2DePix API - Documentacao Completa.md](./Pix2DePix%20API%20-%20Documentacao%20Completa.md)
- [Wiki 2.0 Review Mirror](./wiki/README.md)

## Como ler junto com a Wiki

- Wiki: visao institucional, onboarding, leitura guiada e governanca
- `docs/`: detalhes tecnicos versionados junto do codigo
- repo: implementacao real, migrations, testes e configuracao

Quando houver divergencia entre narrativa e implementacao, o repo e a fonte de verdade tecnica.

## Modelo de transicao

O split operacional foi concluido para os destinos principais. Referencias novas
de ownership devem usar estes repositorios:

- `dev865077/DeBot`: runtime Telegram e experiencia do usuario.
- `dev865077/Sagui`: superficie financeira, Eulen, D1 financeiro, webhooks e rotas ops.
- `dev865077/AutoIA-Github`: workflows, prompts e automacoes de GitHub.

Referencias antigas que tratem o monolito como destino permanente sao historicas
e devem ser atualizadas quando o documento for tocado por uma mudanca de produto.

O inventario operacional comum de variaveis, bindings e segredos fica em
[`docs/operations/secrets-and-environment-inventory.md`](./operations/secrets-and-environment-inventory.md).

## Regra de uso daqui para frente

- novos documentos tecnicos devem nascer em `docs/`
- documentos antigos na raiz nao sao mais o destino padrao para nova documentacao
- se uma PR muda arquitetura, schema, integracao, operacao ou observabilidade, ela deve atualizar esta pasta

## Material legado na raiz

Os arquivos abaixo continuam uteis como contexto historico, mas nao sao mais a camada canonica de navegacao:

- `Contexto.md`
- `Contexto Consolidado.md`
- `Checklist de Pre-Voo.md`
- `Faturamento Automações.md`
- `Arquitetura Tecnica do MVP.md`
- `Backlog Scrum do MVP.md`

## Observacao sobre referencias importadas

`Pix2DePix API - Documentacao Completa.md` foi trazido como referencia extensa de integracao. O conteudo tecnico e util, mas parte da navegacao interna ainda reflete o formato original de Obsidian e pode ser normalizada depois em uma limpeza dedicada.
