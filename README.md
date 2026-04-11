# DePix MVP

MVP `DePix-first` para venda automatizada via `Telegram`, cobranca Pix pela API da Eulen/DePix e operacao enxuta na Cloudflare.

## Objetivo

Construir um bot transacional capaz de:

- receber a jornada inicial no Telegram
- capturar valor e carteira
- criar cobranca Pix via Eulen
- confirmar pagamento por webhook
- reconciliar pedidos por fallback
- concluir pedidos de `DePix`

## Stack base

- `Cloudflare Workers`
- `D1`
- `Cron Triggers`
- `Workers Logs`
- `Cloudflare Secrets`

## Escopo do MVP

Dentro do MVP:

- `Telegram`
- `deposit`
- webhook `deposit`
- `deposit-status`
- `deposits`
- idempotencia por `nonce`
- entrega `DePix`

Fora do MVP:

- `BTC`
- `USDT`
- Instagram
- WhatsApp
- painel operacional avancado
- IA de suporte

## Estrutura inicial do repositório

- `src/`
  Runtime inicial do Worker.
- `wrangler.toml`
  Configuracao base do projeto Cloudflare.
- `package.json`
  Scripts de desenvolvimento e deploy.
- `docs/`
  Convencoes e documentacao tecnica do repositorio.

## Convencao de documentacao no codigo

Este projeto segue uma regra de documentacao mais forte que o usual:

- cada arquivo de codigo deve abrir com um comentario em formato de pequeno paragrafo explicando o papel do arquivo
- cada funcao relevante deve ter comentario proprio
- comentarios devem explicar responsabilidade, entradas, saidas e intencao
- a documentacao tecnica principal pode viver em arquivos `.md`
- quando isso ajudar entendimento de devs e outras IAs, o codigo deve apontar para esses `.md` por comentario
- a base do projeto e `100% JavaScript`

O objetivo e deixar a documentacao distribuida entre:

- contexto tecnico mais amplo em `.md`
- explicacao operacional diretamente no codigo

## Documentacao de planejamento

O planejamento principal do MVP foi estruturado no vault do Obsidian do projeto, incluindo:

- `Misc/DePix/Faturamento Automações.md`
- `Misc/DePix/Arquitetura Tecnica do MVP.md`
- `Misc/DePix/Docs/Cloudflare para o MVP - Free Tier e Arquitetura Simples.md`
- `Misc/DePix/Docs/Pix2DePix API - Documentacao Completa.md`
- `Misc/DePix/Scrum/`

## Como iniciar

```bash
npm install
npm run dev
```

## Proximos passos

- conectar o bot do Telegram
- configurar `Cloudflare Secrets`
- criar schema inicial do `D1`
- implementar client Eulen
- subir webhook e reconciliacao
