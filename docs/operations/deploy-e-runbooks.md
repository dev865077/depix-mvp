# Deploy e Runbooks

## Objetivo

Registrar o fluxo operacional basico do projeto e os pontos que ja existem no repositorio.

## Scripts relevantes

Definidos em `package.json`:

- `npm run dev`
- `npm test`
- `npm run cf:types`
- `npm run db:migrate:local`
- `npm run db:query:local`
- `npm run deploy:test`
- `npm run deploy:production`

## Endpoints operacionais do Worker

- `GET /health`
- `POST /telegram/:tenantId/webhook`
- `POST /webhooks/eulen/:tenantId/deposit`
- `POST /ops/:tenantId/recheck/deposit`

## Leitura correta do `main`

Hoje:

- `GET /health` responde de forma funcional
- as rotas de Telegram, webhook Eulen e recheck ja existem como fronteiras canonicas
- webhook Eulen e recheck ainda sao placeholders

## Runbook minimo de verificacao

### Verificar runtime exposto

- confirmar `GET /health`
- confirmar ambiente esperado em logs e config

### Verificar tenant routing

- confirmar que o path inclui `tenantId`
- confirmar que o tenant resolvido existe no `TENANT_REGISTRY`

### Verificar secrets

- confirmar existencia dos bindings do tenant
- nunca logar tokens nem secrets

## Observabilidade minima

Os logs devem carregar, quando aplicavel:

- `tenantId`
- `orderId`
- `depositId`
- `nonce`
- `requestId`

Essa trilha e mais importante que ornamentacao de logging.
