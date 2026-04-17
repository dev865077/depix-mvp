# Documentacao Tecnica

Esta pasta e a casa canonica da documentacao tecnica versionada do repositorio.

## Documentos atuais

- [Cloudflare para o MVP - Free Tier e Arquitetura Simples.md](./Cloudflare%20para%20o%20MVP%20-%20Free%20Tier%20e%20Arquitetura%20Simples.md)
- [Pix2DePix API - Documentacao Completa.md](./Pix2DePix%20API%20-%20Documentacao%20Completa.md)
- [Wiki 2.0 Review Mirror](./wiki/README.md)

## Como ler junto com a Wiki

- Wiki: visao institucional, onboarding, leitura guiada e governanca
- `docs/`: detalhes tecnicos versionados junto do codigo
- repo: implementacao real, migrations, testes e configuracao

Quando houver divergencia entre narrativa e implementacao, o repo e a fonte de verdade tecnica.

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
