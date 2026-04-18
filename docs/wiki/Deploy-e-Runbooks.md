# Deploy e Runbooks

## Scripts relevantes

- `npm run dev`
- `npm test`
- `npm run cf:types`
- `npm run db:migrate:local`
- `npm run db:query:local`
- `npm run deploy:test`
- `npm run deploy:production`

## Endpoints operacionais

- `GET /health`
- `POST /telegram/:tenantId/webhook`
- `POST /webhooks/eulen/:tenantId/deposit`
- `POST /ops/:tenantId/recheck/deposit`
- `GET /ops/:tenantId/telegram/webhook-info`
- `POST /ops/:tenantId/telegram/register-webhook`
- `GET /ops/:tenantId/eulen/ping`
- `POST /ops/:tenantId/eulen/create-deposit`

## Estado atual do `main`

- `GET /health` responde
- as fronteiras canonicas de rota ja existem
- `POST /telegram/:tenantId/webhook` ja faz despacho real para `grammY`
- `POST /webhooks/eulen/:tenantId/deposit` ja processa o webhook principal da Eulen
- `POST /ops/:tenantId/recheck/deposit` ja consulta `deposit-status`, persiste o evento `recheck_deposit_status` e reconcilia `deposits` + `orders`
- as rotas de diagnostico operacional existem, mas ficam fechadas por padrao e dependem de `ENABLE_LOCAL_DIAGNOSTICS=true`

## Recheck de deposito

- pre-condicao de rollout: `ENABLE_OPS_DEPOSIT_RECHECK=true`
- payload minimo: `{ "depositEntryId": "..." }`
- header obrigatorio: `Authorization: Bearer <OPS_ROUTE_BEARER_TOKEN>`
- opcional com menor blast radius: `Authorization: Bearer <binding declarado em opsBindings.depositRecheckBearerToken>`
- ancora local: `depositEntryId`
- fonte de verdade remota: `deposit-status`
- trilha local: evento `deposit_events.source = "recheck_deposit_status"`
- efeito esperado: hidratar `qrId` quando necessario e aplicar o status reconciliado em `deposits` e `orders`
- persistencia critica: evento de auditoria + `deposits` + `orders` sao gravados no mesmo batch do D1 para reduzir risco de estado parcial

## Contrato operacional do recheck

- sem `ENABLE_OPS_DEPOSIT_RECHECK=true`, responde `503 ops_route_disabled`
- a rota fica globalmente pronta quando `ENABLE_OPS_DEPOSIT_RECHECK=true` e `OPS_ROUTE_BEARER_TOKEN` estiver configurado como segredo do Worker
- quando o tenant declarar `opsBindings.depositRecheckBearerToken`, esse token tenant-scoped tem precedencia sobre o token global
- tenant sem override declarado continua usando o token global; tenant com override declarado so usa o binding proprio e responde `503 ops_route_disabled` se esse segredo estiver ausente ou invalido
- sem header Bearer, responde `401 ops_authorization_required`
- com token invalido, responde `403 ops_authorization_invalid`
- se o deposito nao existir no tenant informado, responde `404 deposit_not_found`
- se o agregado local estiver quebrado e o `order` nao existir, responde `409 order_not_found`
- se `deposit-status` devolver `qrId` ja associado a outro deposito, responde `409 deposit_qr_id_conflict`
- se `deposit-status` divergir de um `qrId` ja correlacionado no deposito atual, responde `409 deposit_qr_id_mismatch`
- se o agregado local ja estiver concluido e `deposit-status` voltar com estado inferior nao terminal, responde `409 deposit_status_regression`
- se a Eulen nao responder com um `status` utilizavel, responde `502 deposit_status_invalid_response`
- se a consulta remota falhar, responde `502 deposit_status_unavailable`
- recheck repetido com a mesma verdade remota e idempotente: nao duplica `deposit_events` e pode apenas reparar o agregado se um estado historico tiver ficado incompleto

## Retry e precedencia

- esta rota e uma ferramenta manual de suporte, nao substitui o webhook principal nem o fallback futuro por `deposits`
- retry manual depois de `502 deposit_status_unavailable` e permitido
- retry manual depois de `409 deposit_status_regression`, `409 deposit_qr_id_conflict` ou `409 deposit_qr_id_mismatch` nao deve ser tratado como tentativa cega; primeiro e preciso entender a divergencia
- quando o agregado local ja estiver concluido por `depix_sent`, o recheck nao aceita um `deposit-status` atrasado que volte com `pending`, `under_review` ou outro estado inferior

## Acao do operador por resposta

- `200 deposit_recheck_processed`: registrar `requestId`, `tenantId`, `depositEntryId`, `eventId` e seguir com a conciliacao concluida
- `200 deposit_recheck_duplicate`: registrar `requestId` e tratar como replay idempotente; nao repetir indefinidamente
- `401 ops_authorization_required` ou `403 ops_authorization_invalid`: validar token, escopo do tenant e rotacao recente do segredo antes de qualquer nova tentativa
- `404 deposit_not_found`: confirmar se o `depositEntryId` pertence ao tenant do path; nao insistir com outro tenant no mesmo request
- `409 order_not_found`: tratar como agregado local quebrado e abrir correcao de dados antes de novo recheck
- `409 deposit_qr_id_conflict` ou `409 deposit_qr_id_mismatch`: parar retries cegos, anexar `requestId` e investigar correlacao local versus resposta remota
- `409 deposit_status_regression`: preservar o agregado concluido local, registrar a divergencia e comparar webhook/eventos antes de qualquer acao manual
- `502 deposit_status_invalid_response` ou `502 deposit_status_unavailable`: considerar falha transitoria ou upstream inconsistente; retry manual controlado e permitido
- `500 deposit_recheck_persistence_incomplete`: assumir que o batch pode ter sido persistido, anexar `requestId`, `tenantId`, `depositEntryId` e `orderId`, inspecionar o historico do deposito e repetir no maximo um retry controlado; o caminho continua idempotente por `depositEntryId` + payload do evento
- `503 ops_route_disabled_invalid_flag`: corrigir o valor de `ENABLE_OPS_DEPOSIT_RECHECK`; typo ou valor legado mantem a rota desligada ate o deploy/config ser saneado
- `503 ops_route_disabled`: confirmar flag `ENABLE_OPS_DEPOSIT_RECHECK`, token global e eventual override tenant-scoped antes de tratar como incidente de negocio

## Rollout e rollback

- rollout: manter `ENABLE_OPS_DEPOSIT_RECHECK` fora do `wrangler.jsonc` versionado; provisionar `ENABLE_OPS_DEPOSIT_RECHECK=true` e `OPS_ROUTE_BEARER_TOKEN` apenas nos ambientes que devem expor a ferramenta, publicar o deploy e validar um smoke test autenticado com um `depositEntryId` conhecido
- rollout atual esperado: `local`, `test` e `production` ficam desligados por padrao no config versionado; cada ambiente so fica operacionalmente ativo depois da provisao explicita da flag e dos secrets
- rollback rapido global: trocar `ENABLE_OPS_DEPOSIT_RECHECK` para `false`; a rota passa a devolver `503 ops_route_disabled` sem afetar webhook principal, Telegram ou leitura de saude
- rollback rapido por segredo: remover ou rotacionar `OPS_ROUTE_BEARER_TOKEN` ou o binding tenant-scoped correspondente
- rollback funcional: mesmo sem usar a rota, o caminho principal de confirmacao continua sendo o webhook da Eulen

## Checklist de migracao para auth tenant-scoped

- tenants existentes continuam no caminho global por padrao; nenhuma entrada antiga precisa ser alterada para o rollout inicial
- para migrar um tenant, primeiro provisionar o novo segredo, depois declarar `opsBindings.depositRecheckBearerToken` no `TENANT_REGISTRY`, validar em `test` com o token novo e so entao repetir em `production`
- se o tenant override for declarado com binding ausente ou vazio, aquele tenant falha fechado com `503`; o rollback imediato e remover a declaracao do registry ou corrigir o segredo provisionado
- se `/health` retornar `tenantOverrides.state = invalid_config`, tratar como erro local de configuracao: algum override tenant-scoped foi declarado sem segredo valido, enquanto tenants sem override continuam herdando o token global
- todo request autorizado registra `authScope` e `bindingName` em log estruturado, o que vira a trilha canonica para triagem operacional

## Checklist de aceite operacional

- `test` habilitado e validado antes de qualquer uso em `production`
- `production` habilitado so depois do smoke test autenticado em `test`
- `/health` confirma `configuration.operations.depositRecheck.state` e `ready` como sinal redigido de prontidao global; valores esperados: `ready`, `disabled`, `invalid_config` ou `missing_secret`
- `/health` confirma `configuration.operations.depositRecheck.tenantOverrides.state` como sinal redigido de overrides locais; `invalid_config` nesse campo nao derruba a prontidao global, mas indica que ao menos um tenant com override declarado falhara fechado ate o segredo ser corrigido
- `/health` mantem `configuration.tenants` como inventario legado de tenants para compatibilidade operacional e adiciona `configuration.tenantSummary` para checagens agregadas novas
- `/health` nao lista detalhes tenant-level dentro de `tenantOverrides`; esse contrato e redigido por desenho: `{ state, invalidCount }`. A trilha tenant-level fica nos logs estruturados de request/config, com `requestId`, `tenantId`, `authScope`, `bindingName` operacional e outcome.
- migracao de consumidores de `/health`: dashboards e probes existentes podem continuar lendo `configuration.tenants`; novos checks devem preferir `configuration.tenantSummary` para contagem/configuracao e `configuration.operations.depositRecheck` para a rota operacional
- nomenclatura canonica: o log estruturado de configuracao usa `config.deposit_recheck.tenant_override_invalid`; a API de health usa `configuration.operations.depositRecheck.tenantOverrides.state = "invalid_config"` como sinal publico final
- operadores sabem pela documentacao que override por tenant e opt-in e declarado no `TENANT_REGISTRY`
- rollback rapido documentado por flag e por rotacao/remocao do segredo

## Verificacao minima

- confirmar `GET /health`
- confirmar `tenantId` no path das rotas multi-tenant
- confirmar bindings do tenant
- confirmar se `test` e `production` estao usando `Cloudflare Secrets Store` como esperado
- confirmar se a validacao local de diagnostico esta desabilitada em ambientes publicos
- nunca logar tokens nem secrets

## Regra de operacao

Runbook curto e executavel vale mais do que texto operacional longo e desatualizado.
