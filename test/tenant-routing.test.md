## tenant-routing.test.js

Este teste cobre o roteamento multi-tenant da borda HTTP do Worker.

O que ele verifica hoje:

- `POST /telegram/alpha/webhook` resolve o tenant `alpha`, entra no caminho do webhook do Telegram com o secret header correto e espera resposta `200`
- o update usado nesse teste nao possui canal de resposta outbound, para validar apenas o roteamento e o ack HTTP do webhook
- a chamada do Telegram tambem deve devolver o header `x-request-id` e corpo vazio
- `POST /webhooks/eulen/beta/deposit` resolve o tenant `beta` e, no estado atual, responde `404` com `deposit_not_found`
- uma rota com tenant inexistente falha com `404`

Observacao:

- este arquivo documenta apenas o comportamento atual do teste
- ele nao define regra de produto nova nem substitui a documentacao de arquitetura
