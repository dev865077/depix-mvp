## tenant-routing.test.js

Este teste cobre o roteamento multi-tenant da borda HTTP do Worker.

O que ele verifica hoje:

- `POST /telegram/alpha/webhook` resolve o tenant `alpha`, entra no caminho do webhook do Telegram e espera resposta `200`
- a chamada do Telegram tambem deve devolver o header `x-request-id` e corpo vazio
- `POST /webhooks/eulen/beta/deposit` resolve o tenant `beta` e, no estado atual, responde `501`
- uma rota com tenant inexistente falha com `404`

Observacao:

- este arquivo documenta apenas o comportamento atual do teste
- ele nao define regra de produto nova nem substitui a documentacao de arquitetura
