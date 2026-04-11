# DePix MVP

MVP `DePix-first` para venda automatizada via `Telegram`, cobranca Pix pela API
da Eulen/DePix e operacao enxuta na Cloudflare.

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

## Estrutura atual do repositorio

- `src/`
  runtime do Worker em modulos pequenos e comentados
- `src/lib/http/`
  respostas JSON e roteamento simples
- `src/lib/telegram/`
  estados e fluxo inicial da conversa
- `src/lib/data/`
  binding `D1`, schema e repositorios base
- `src/lib/observability/`
  logger estruturado minimo
- `migrations/`
  schema versionado inicial do `D1`
- `docs/`
  convencoes e documentacao tecnica do repositorio
- `wrangler.toml`
  configuracao base do projeto Cloudflare

## Convencao de documentacao no codigo

Este projeto segue uma regra de documentacao mais forte que o usual:

- cada arquivo de codigo deve abrir com um comentario em formato de pequeno paragrafo explicando o papel do arquivo
- cada funcao relevante deve ter comentario proprio
- comentarios devem explicar responsabilidade, entradas, saidas e intencao
- a documentacao tecnica principal pode viver em arquivos `.md`
- quando isso ajudar entendimento de devs e outras IAs, o codigo deve apontar para esses `.md` por comentario
- a base do projeto e `100% JavaScript`

## Documentacao recomendada

- `docs/IMPLEMENTATION-CONVENTIONS.md`
- `docs/ARCHITECTURE-FOUNDATION.md`
- `migrations/0001_initial_schema.sql`

No vault do Obsidian, o planejamento principal vive em:

- `Misc/DePix/Faturamento Automacoes.md`
- `Misc/DePix/Arquitetura Tecnica do MVP.md`
- `Misc/DePix/Docs/Cloudflare para o MVP - Free Tier e Arquitetura Simples.md`
- `Misc/DePix/Docs/Pix2DePix API - Documentacao Completa.md`
- `Misc/DePix/Scrum/`

## Como iniciar

```bash
npm install
npm run dev
```

## Estado atual

Ja pronto:

- bootstrap modular do Worker
- estados iniciais da conversa
- fluxo inicial `DePix-first`
- schema inicial de `D1`
- repositorios base para pedidos, sessoes e eventos externos

Proximos passos:

- conectar o adaptador real do Telegram
- configurar bindings reais de `D1`
- configurar `Cloudflare Secrets`
- implementar client Eulen
- subir webhook e reconciliacao
