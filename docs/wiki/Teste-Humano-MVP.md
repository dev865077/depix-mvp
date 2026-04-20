# Teste Humano MVP

Este runbook guia a validacao operacional do MVP por um operador. O objetivo e provar, com evidencia, que o fluxo real sai do Telegram, cria deposito na Eulen, entrega QR Pix/DePix, observa pagamento e chega a estado final consistente.

Este documento nao substitui a UX final do bot. As melhorias de `/help`, onboarding e mensagem de QR continuam acompanhadas por #132 e #135.

## Resultado esperado

Ao fim de cada execucao, a issue de validacao deve ter evidencia suficiente para responder:

- qual ambiente, tenant, bot e endpoint foram usados
- qual versao estava deployada
- qual usuario executou o fluxo no Telegram
- qual `orderId`, `depositEntryId` e `qrId` foram gerados
- quais `requestId` e status HTTP apareceram nas chamadas operacionais
- quais estados ficaram em `orders` e `deposits`
- se o pagamento fechou o ciclo ou abriu risco residual

## Referencias canonicas

- [Deploy e Runbooks](Deploy-e-Runbooks)
- [Ambientes e Segredos](Ambientes-e-Segredos)
- [Testes e Qualidade](Testes-e-Qualidade)
- [Modelo de Dados](Modelo-de-Dados)
- [Integracoes Externas](Integracoes-Externas)
- [`scripts/collect-qr-flow-evidence.mjs`](https://github.com/dev865077/depix-mvp/blob/main/scripts/collect-qr-flow-evidence.mjs)
- [#124 validar pagamento real em test](https://github.com/dev865077/depix-mvp/issues/124)
- [#125 promover validacao controlada para production](https://github.com/dev865077/depix-mvp/issues/125)
- [#128 ampliar evidencia pos-QR](https://github.com/dev865077/depix-mvp/issues/128)
- [#132 help e onboarding](https://github.com/dev865077/depix-mvp/issues/132)
- [#135 mensagem do QR](https://github.com/dev865077/depix-mvp/issues/135)

## Pre-requisitos do operador

Antes de iniciar:

- acesso ao GitHub do repositorio
- acesso ao Cloudflare do projeto
- `wrangler` autenticado para consultar D1 remoto
- token operacional para `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- acesso ao Telegram com os bots corretos do ambiente
- pagador capaz de pagar o QR gerado
- horario inicial em ISO-8601, por exemplo `2026-04-19T14:00:00Z`

Se o `wrangler` nao conseguir consultar D1 remoto, pare. Registre que a auth local esta ausente, corrija token/login Cloudflare e repita o preflight antes de qualquer validacao real.

## Hosts canonicos

- `test`: `https://depix-mvp-test.dev865077.workers.dev`
- `production`: `https://depix-mvp-production.dev865077.workers.dev`

Use sempre esses hosts para evidencia. Nao use host generico sem confirmar que ele e canonico para o ambiente.

## Tenants

Execute por tenant quando a issue pedir. O formato dos endpoints usa:

```text
<BASE_URL>/ops/<tenantId>/...
<BASE_URL>/telegram/<tenantId>/webhook
```

Os exemplos usam `TENANT_ID="alpha"` apenas como placeholder. Troque para o tenant sob validacao antes de executar comandos.

## Preflight em test

Defina variaveis locais para reduzir erro de copia:

```bash
BASE_URL="https://depix-mvp-test.dev865077.workers.dev"
TENANT_ID="alpha"
PUBLIC_BASE_URL="$BASE_URL"
SINCE_ISO="2026-04-19T14:00:00Z"
```

Confirme health:

```bash
curl --fail-with-body -sS -w "\nHTTP_STATUS=%{http_code}\n" "$BASE_URL/health"
```

Registre `status`, `environment`, `requestId`, tenants reportados, `HTTP_STATUS` e qualquer indicacao de secrets/split ausentes. Se `curl` falhar ou `HTTP_STATUS` nao for 2xx, pare o preflight.

Confirme webhook do Telegram:

```bash
curl --fail-with-body -sS -w "\nHTTP_STATUS=%{http_code}\n" \
  -H "Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>" \
  "$BASE_URL/ops/$TENANT_ID/telegram/webhook-info?publicBaseUrl=$PUBLIC_BASE_URL"
```

Se o webhook estiver ausente ou apontar para host errado, registre a divergencia antes de mutar o webhook:

```bash
curl --fail-with-body -sS -w "\nHTTP_STATUS=%{http_code}\n" \
  -X POST \
  -H "Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"publicBaseUrl\":\"$PUBLIC_BASE_URL\"}" \
  "$BASE_URL/ops/$TENANT_ID/telegram/register-webhook"
```

Confirme D1 e migrations:

```bash
npx wrangler d1 migrations list DB --remote --env test
```

Colete baseline:

```bash
node scripts/collect-qr-flow-evidence.mjs --env test --tenant "$TENANT_ID" --since "$SINCE_ISO"
```

## Fluxo Telegram em test

No bot correto do tenant:

1. envie `/start`
2. informe o valor em BRL
3. informe o endereco DePix/Liquid
4. confirme com `sim`, `confirmar` ou `ok`
5. aguarde QR/copia-e-cola
6. envie `/status` para confirmar que o bot encontra o pedido correto sem criar outro pedido
7. pague o QR
8. aguarde a mensagem assincrona de confirmacao no Telegram quando o pagamento for conciliado
9. acompanhe o estado final pelo webhook, por `/status` ou por recheck operacional se a confirmacao nao chegar
10. use `/help` se precisar de orientacao contextual sem alterar o pedido

Registre screenshot ou transcricao do Telegram com horario absoluto.

## Evidencia depois do QR

Depois de receber QR:

```bash
node scripts/collect-qr-flow-evidence.mjs --env test --tenant "$TENANT_ID" --since "$SINCE_ISO" --issue 124
```

O comentario final deve incluir:

- `orderId`
- `depositEntryId`
- `qrId` quando existir
- `orders.status`
- `orders.current_step`
- `deposits.external_status`
- horario absoluto da mensagem assincrona recebida no Telegram, ou a ausencia controlada dela
- requestIds relevantes
- logs ou erro observado

Quando #128 estiver pronto, inclua tambem `deposit_events`. Antes disso, trate `deposit_events` como melhoria de evidencia, nao como bloqueio do runbook inicial.

## Recheck pontual

Use somente para o deposito afetado:

```bash
curl --fail-with-body -sS -w "\nHTTP_STATUS=%{http_code}\n" \
  -X POST \
  -H "Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"depositEntryId\":\"<depositEntryId>\"}" \
  "$BASE_URL/ops/$TENANT_ID/recheck/deposit"
```

Registre `requestId`, status HTTP, `depositEntryId`, `qrId`, `eventId` e resultado.

## Fallback por janela

Use quando o webhook atrasar ou faltar e houver janela operacional clara. A rota consulta uma janela de depositos remotos, entao ela tem blast radius maior que o recheck pontual.

Em `production`, use este fallback apenas quando todos os itens forem verdadeiros:

- #124 ja passou e #125 esta registrando a execucao atual
- o recheck pontual do `depositEntryId` afetado nao resolveu
- existe janela curta conhecida, com `start` e `end` em ate 24 horas
- o operador responsavel pela execucao registrou no comentario da issue por que o fallback e necessario

Payload minimo:

```bash
curl --fail-with-body -sS -w "\nHTTP_STATUS=%{http_code}\n" \
  -X POST \
  -H "Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"start\":\"2026-04-19T14:00:00Z\",\"end\":\"2026-04-19T14:30:00Z\",\"status\":\"depix_sent\"}" \
  "$BASE_URL/ops/$TENANT_ID/reconcile/deposits"
```

Nao use como retry cego. Registre janela, `HTTP_STATUS`, linhas aplicadas, linhas ignoradas e conflitos.

## Criterios de parada em test

- o QR foi gerado e evidenciado
- o pagamento foi conciliado ou o erro foi isolado de forma conclusiva
- o estado final ficou consistente em `orders` e `deposits`
- a mensagem assincrona foi observada ou a ausencia foi justificada com recheck e logs
- a issue recebeu comentario com evidencia suficiente

## Criterios de parada em production

Production nao deve ser usada para improviso.

Antes de executar:

- conferir aprovacao da issue correspondente
- conferir janela operacional combinada
- conferir se o risco de recheck e fallback foi aceito
- conferir se ha suporte responsavel online
- conferir se a mensagem de smoke esta pronta para ser registrada no comentario da issue

## Risco residual

Se a conciliacao nao chegar, o operador nao deve repetir a compra no escuro. A ordem correta e registrar evidencia, rodar recheck pontual, e so depois considerar fallback por janela quando a janela e o impacto estiverem claros.
