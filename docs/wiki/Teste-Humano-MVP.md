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

Execute o preflight canonico antes de qualquer compra real:

```bash
OPS_ROUTE_BEARER_TOKEN="<token operacional>" \
  npm run telegram:preflight -- \
  --env test \
  --tenant "$TENANT_ID" \
  --out "artifacts/telegram-real-flow/preflight-test-$TENANT_ID.json"
```

O preflight deve ficar verde para:

- `GET /health`
- secrets e split do tenant
- URL canonica do webhook Telegram
- `allowed_updates` contendo `callback_query`
- comandos publicos `/start`, `/help`, `/status`, `/cancel`
- menu button do Telegram em modo `commands`

Se qualquer item falhar, pare. Nao execute a compra real ate corrigir o diagnostico do JSON.

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

## Runner real assistido

O runner real nao conversa por voce nem gasta dinheiro sozinho. Ele inicia o `wrangler tail`, observa logs reais e escreve um unico JSON de evidencia. A conversa e o pagamento continuam sendo acao manual do operador.

Sem a flag `--confirm-real`, o runner aborta e escreve evidencia de bloqueio:

```bash
npm run telegram:real-run -- \
  --env production \
  --tenant alpha \
  --amount-brl 3 \
  --wallet "<endereco lq1 ou ex1>" \
  --out artifacts/telegram-real-flow/real-run-production-alpha.json
```

Para uma execucao real controlada:

```bash
npm run telegram:real-run -- \
  --env production \
  --tenant alpha \
  --amount-brl 3 \
  --wallet "<endereco lq1 ou ex1>" \
  --confirm-real \
  --require-payment-confirmed \
  --out artifacts/telegram-real-flow/real-run-production-alpha.json
```

Enquanto o runner estiver aberto, faca no Telegram:

1. envie `/start`
2. envie o valor configurado em `--amount-brl`
3. envie o endereco configurado em `--wallet`
4. toque no botao `Confirmar`, sem confirmar por texto
5. pague o Pix manualmente
6. aguarde o runner registrar sucesso ou falha

O JSON gerado e o artefato canonico do teste real.

## Fluxo Telegram em test

No bot correto do tenant:

1. envie `/start`
2. informe o valor em BRL
3. informe o endereco DePix/Liquid
4. confirme com `sim`, `confirmar` ou `ok`
5. aguarde QR/copia-e-cola
6. verifique que a mensagem do QR orienta de forma clara o pagamento e o proximo passo
7. se a Eulen devolver expiracao, confirme que ela aparece na copy; se nao devolver, a expiracao nao deve ser inventada
8. se o Telegram rejeitar a imagem do QR, confirme que o fluxo cai para texto puro sem perder a instrucao de pagamento
9. envie `/status` para confirmar que o bot encontra o pedido correto sem criar outro pedido
10. pague o QR
11. aguarde a mensagem assincrona de confirmacao no Telegram quando o pagamento for conciliado
12. acompanhe o estado final pelo webhook, por `/status` ou por recheck operacional se a confirmacao nao chegar
13. use `/help` se precisar de orientacao contextual sem alterar o pedido

Registre screenshot ou transcricao do Telegram com horario absoluto.

## Evidencia depois do QR

Depois de gerar o QR, a evidencia deve deixar claro:

- texto exibido ao usuario para pagamento
- se a expiracao apareceu ou nao apareceu, conforme retorno da Eulen
- se o fallback textual preservou as instrucoes quando a imagem foi rejeitada
- resposta do usuario antes da conciliacao
- mensagem final apos pagamento conciliado

## Rechecagem operacional

Se o webhook nao chegar, use o recheck por `depositEntryId` apenas para o deposito especifico ja criado. Nao use o recheck para criar novo deposito, nem para substituir a prova do fluxo Telegram.

## Fechamento da evidencia

Antes de encerrar, confirme que a transcricao final deixa claro:

- `orderId`
- `depositEntryId`
- `qrId`
- `status` final em `orders`
- `status` final em `deposits`
- se houve fallback de texto no Telegram
- se a expiracao veio da Eulen ou ficou ausente por nao retorno upstream

Se algum desses pontos faltar, a validacao fica incompleta.
