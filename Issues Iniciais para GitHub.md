# Issues Iniciais para GitHub

Este arquivo converte os gaps atuais do projeto em issues com padrao mais profissional, pensadas para backlog real de engenharia. O objetivo e que cada issue ja nasca clara o suficiente para priorizacao, refinamento e implementacao, sem parecer uma nota solta ou uma PR disfarcada.

## Como usar este arquivo

- Cada bloco abaixo pode virar uma issue separada no GitHub.
- O ideal e ajustar apenas identificadores internos, labels e owner antes de publicar.
- As issues foram escritas para funcionar bem com triagem, planejamento tecnico e futura PR real.
- Onde houver dependencia forte de outro trabalho, isso esta indicado explicitamente.

---

# Issue 1

## Title

Implement Telegram runtime with grammY and XState for the core MVP flow

## Type

Feature / Architecture

## Priority

P0

## Summary

The core user entrypoint described in the current product and architecture docs does not exist in the codebase yet. The Telegram webhook is still a `501` placeholder, and the runtime does not include either `grammY` or `XState`, even though both are now part of the documented backbone of the MVP.

This creates a structural mismatch between the documented system and the actual application: the Worker has the shape of the final product, but not the operational path that users will actually enter through.

## Problem

Today, the project exposes a Telegram route but does not implement a real Telegram bot runtime. There is no conversational orchestration layer, no explicit state machine for order progression, and no production-grade entrypoint for the tenant-specific bot flows.

As a result:

- the most important product surface is not functional
- the codebase cannot yet express the intended conversational lifecycle
- downstream payment and reconciliation work has no real upstream driver
- the implementation remains materially behind the current system definition in the docs

## Why this matters now

This is not a nice-to-have feature. It is the primary application entrypoint of the MVP. Without it, the project cannot be considered aligned with the current documented version of the product.

This work also unlocks several downstream efforts:

- tenant-aware bot behavior
- order state orchestration
- payment initiation from a real conversational flow
- realistic end-to-end testing of the user journey

## Proposed scope

- add `grammY` as the Telegram runtime layer
- add `XState` as the explicit orchestration model for order progression
- replace the `501` Telegram webhook placeholder with a real request path
- define the first production-grade shape of the conversational order flow
- ensure tenant context is available throughout the Telegram runtime path
- standardize logging, error handling and request metadata for Telegram events
- update architecture and flow documentation in the same change

## Out of scope

- full Eulen webhook confirmation flow
- full reconciliation fallback implementation
- complete test coverage for every downstream payment scenario
- advanced operator tooling

## Acceptance criteria

- Telegram webhook no longer returns `501`
- `grammY` is integrated into the Worker runtime
- `XState` is used to model at least the initial order progression path
- tenant-aware routing works correctly for bot requests
- application logs clearly identify request, tenant and flow context
- docs are updated to reflect the implemented runtime shape

## Technical notes

- This should not be implemented as handler glue alone; the conversational flow needs an explicit state boundary.
- The design should avoid coupling Telegram transport concerns directly to payment domain logic.
- Multi-tenant constraints must remain explicit throughout the runtime path.

## Dependencies

- no hard dependency on the Eulen webhook implementation
- should be designed to integrate cleanly with future payment and reconciliation services

## Risks

- introducing a bot runtime without a clean domain boundary may create long-term coupling
- introducing a state machine too late or too shallowly may force a rewrite during payment integration

## Validation expectations

- local tests for the Telegram webhook path
- transition tests for the initial XState flow
- tenant-aware smoke test
- manual validation that the bot runtime boots correctly in the Worker environment

## Documentation impact

- Contexto.md
- Faturamento Automacoes.md
- Arquitetura Tecnica do MVP.md
- Backlog Scrum do MVP.md if task structure changes

## Evidence

- `package.json`
- `src/routes/telegram.js`
- `src/app.js`

---

# Issue 2

## Title

Implement Eulen deposit webhook and operational reconciliation flow

## Type

Feature / Reliability

## Priority

P0

## Summary

The documented payment confirmation model is not implemented yet. The Eulen deposit webhook remains a placeholder, and the operational fallback path via `deposit-status` and `deposits` is also not active.

This leaves the system without its primary source of payment truth and without the documented recovery path when webhooks are delayed, duplicated or lost.

## Problem

The current code exposes the critical routes for webhook and recheck, but both still return `501`. The Eulen client offers low-level helpers, but there is no application service that turns those helpers into a real confirmation and reconciliation workflow.

As a result:

- payment confirmation is not operational
- the system cannot recover consistently from missing or delayed callbacks
- order and deposit state transitions are not yet aligned with the documented operational model
- the codebase still lacks the central reliability path for the MVP

## Why this matters now

The Telegram flow can only become a true product flow if payment confirmation exists. This issue closes one of the most important gaps between architecture and implementation.

This is also where the product begins to behave like a real financial workflow rather than a structural prototype.

## Proposed scope

- implement `/webhooks/eulen/:tenantId/deposit`
- implement `/ops/:tenantId/recheck/deposit`
- create an application service for deposit confirmation and reconciliation
- persist external events in `deposit_events`
- update `orders` and `deposits` consistently based on webhook and fallback results
- introduce idempotency behavior for repeated webhook delivery
- operationalize `deposit-status` and `deposits` as fallback paths
- update docs for runtime, payment flow and operations

## Out of scope

- full Telegram runtime implementation if not already in place
- advanced observability dashboards
- broader product expansion outside the current DePix MVP

## Acceptance criteria

- Eulen deposit webhook no longer returns `501`
- recheck endpoint no longer returns `501`
- webhook events are persisted with tenant context
- repeated or duplicate webhook calls do not corrupt state
- recheck can reconcile a deposit when webhook delivery is missing or delayed
- order and deposit updates remain internally consistent
- docs clearly reflect the implemented truth model

## Technical notes

- Critical writes should follow the documented `env.DB.batch()` guidance where appropriate.
- Idempotency must be treated as a first-class concern, not a later refinement.
- This issue should establish the canonical relationship between webhook truth, fallback truth and stored system state.

## Dependencies

- can be implemented independently from the full Telegram flow
- integrates more cleanly if order state boundaries are already explicit

## Risks

- inconsistent reconciliation logic may produce state drift between orders, deposits and event history
- incomplete idempotency strategy may create false confirmations or duplicate transitions

## Validation expectations

- tests for valid webhook delivery
- tests for repeated webhook delivery
- tests for reconciliation fallback
- tenant isolation tests around webhook and recheck behavior
- manual verification of a delayed-callback recovery scenario

## Documentation impact

- Contexto.md
- Faturamento Automacoes.md
- Arquitetura Tecnica do MVP.md
- Mapa de Uso da API.md

## Evidence

- `src/routes/webhooks.js`
- `src/routes/ops.js`
- `src/clients/eulen-client.js`

---

# Issue 3

## Title

Enforce mandatory split configuration on every charge creation path

## Type

Bug / Business rule enforcement

## Priority

P1

## Summary

The documented rule that every charge must include a split is not guaranteed by the current implementation. Split fields are still treated as optional in the persistence layer, and the deposit creation path does not yet inject or enforce an internal split contract.

## Problem

At the moment, the system can still represent or attempt a charge without the mandatory split configuration required by the documented product model.

This means:

- business rules are not enforced by code
- operational correctness depends on caller discipline
- tenant-specific payment configuration remains under-defined
- the system is still vulnerable to invalid charge creation paths

## Why this matters now

This is a business-critical invariant, not just a data-shape preference. If the split is mandatory by product and commercial logic, the code should make it impossible to skip.

This issue should move split handling from implicit convention to explicit contract.

## Proposed scope

- define required split configuration for charge creation
- inject split data through internal configuration rather than arbitrary payload assembly
- reject charge attempts that do not satisfy the split contract
- align repository defaults and validations with the real business rule
- update local and production configuration examples
- document the runtime expectation for split by tenant

## Out of scope

- full redesign of the payment domain
- tenant onboarding tooling
- revenue analytics or split reporting

## Acceptance criteria

- split is treated as required in the charge creation path
- missing split configuration fails fast with a clear operational error
- repository and runtime configuration no longer imply split is optional for valid charges
- environment examples reflect the required configuration model
- docs clearly describe split as a mandatory invariant

## Technical notes

- This should ideally be enforced at a service boundary rather than only at the storage layer.
- The Eulen request body should be shaped by an internal contract, not accepted as arbitrary raw payload.
- The multi-tenant configuration model should support tenant-specific split settings cleanly.

## Dependencies

- easier to implement once the charge creation service is explicit
- should align with the eventual operational payment path

## Risks

- tightening validation before configuration shape stabilizes may introduce friction during rollout
- if split remains distributed across too many layers, regressions will remain likely

## Validation expectations

- tests for charge creation without split
- tests for valid split injection by tenant
- checks for config completeness in local and production-like setups

## Documentation impact

- Contexto.md
- Faturamento Automacoes.md
- Arquitetura Tecnica do MVP.md

## Evidence

- `src/db/repositories/orders-repository.js`
- `src/clients/eulen-client.js`
- `.dev.vars.example`
- `wrangler.jsonc`

---

# Issue 4

## Title

Validate Telegram and Eulen webhook secrets in the runtime path

## Type

Bug / Security hardening

## Priority

P1

## Summary

Webhook-related secrets appear in configuration, but they are not yet enforced in the actual request path. The system currently advertises secret-aware configuration without applying real request validation in the Telegram or Eulen handlers.

## Problem

The current state creates a false sense of readiness: configuration exists, but the request surface is not protected by it.

This leaves the runtime below the documented operational assumption for external webhooks and bot ingress.

## Why this matters now

Once the webhook paths become real, secret validation stops being optional immediately. This is especially important in a multi-tenant setup, where a weak request boundary can create cross-tenant exposure or operational confusion.

## Proposed scope

- define the validation model for Telegram webhook requests by tenant
- define the validation model for Eulen webhook requests by tenant
- enforce secret checks at the request boundary
- produce clear failure responses for missing, invalid or mismatched secrets
- log failures safely without leaking sensitive values
- document required runtime setup and operational expectations

## Out of scope

- automated secret rotation
- broader auth redesign for internal operations
- centralized secrets lifecycle management beyond the current project need

## Acceptance criteria

- Telegram runtime rejects invalid webhook secret input
- Eulen runtime rejects invalid webhook secret input
- tenant mismatches are handled explicitly
- logs support debugging without exposing secrets
- setup docs explain the required secret configuration and validation behavior

## Technical notes

- This should be implemented as a first-class boundary concern, not sprinkled ad hoc inside business logic.
- The validation strategy should remain compatible with the project's tenant resolution model.
- Secret handling should stay compatible with both Worker Secrets and future Secrets Store usage.

## Dependencies

- best implemented once real Telegram and Eulen handlers exist
- can share common middleware or boundary utilities if done carefully

## Risks

- overly rigid validation may block legitimate traffic if provider-specific behavior is misunderstood
- inconsistent validation behavior across providers may increase operational support load

## Validation expectations

- tests for valid secret cases
- tests for invalid secret cases
- tests for tenant mismatch behavior
- manual smoke checks of configured runtime paths

## Documentation impact

- Arquitetura Tecnica do MVP.md
- Mapa de Uso da API.md
- Contexto.md if operational assumptions change

## Evidence

- `src/config/runtime.js`
- `src/routes/webhooks.js`
- `src/routes/telegram.js`

---

# Issue 5

## Title

Expand test coverage from technical foundation to critical MVP behavior

## Type

Test / Reliability

## Priority

P2

## Summary

The current test suite validates technical foundation only. It does not yet cover the documented core behaviors of the MVP: conversational orchestration, state transitions, mandatory split enforcement, webhook idempotency, reconciliation behavior or tenant-aware critical flow execution.

## Problem

The existing tests are useful, but they validate a system skeleton rather than the product behavior the docs now describe.

This creates two risks:

- implementation can drift away from the intended business flow without detection
- later refactors may accidentally break the most important paths with little safety net

## Why this matters now

As core product paths become real, coverage needs to move up the stack. The system should not rely only on unit-level technical checks once it begins to model payment state, external callbacks and tenant-aware order progression.

## Proposed scope

- add tests for Telegram ingress behavior
- add tests for XState-based flow transitions
- add tests for mandatory split enforcement
- add tests for webhook idempotency
- add tests for reconciliation fallback behavior
- add tests for tenant-aware critical path execution
- strengthen fixtures and mocks for realistic integration scenarios

## Out of scope

- fully hosted end-to-end test infrastructure
- production observability systems
- large-scale load testing

## Acceptance criteria

- test suite covers the documented core behaviors of the MVP
- repeated webhook delivery has explicit automated coverage
- split-required behavior has explicit automated coverage
- tenant isolation exists in critical-path tests
- the suite provides confidence for future refactors of the main workflow

## Technical notes

- Coverage should follow stable contracts, not temporary internals.
- The test plan should evolve from foundation coverage toward behavior coverage.
- Use realistic tenant-aware fixtures to avoid false confidence from single-tenant assumptions.

## Dependencies

- delivers most value after the major functional issues are implemented
- can still begin incrementally as each functional path lands

## Risks

- writing deep tests against unstable contracts may create churn
- under-scoped test fixtures may hide tenant or idempotency bugs

## Validation expectations

- green suite locally
- meaningful coverage for success, duplicate, delayed and reconciliation scenarios

## Documentation impact

- backlog updates if testing gaps reveal missing engineering tasks
- technical docs where tests formalize important contracts

## Evidence

- `test/health.test.js`
- `test/eulen-client.test.js`
- `test/db.repositories.test.js`

---

# Issue 6

## Title

Restore context integrity between Obsidian source docs and workspace onboarding material

## Type

Documentation / Developer experience

## Priority

P2

## Summary

The context chain is not fully self-contained from within the workspace. `Contexto.md` references documents that are not available inside the repository, which means onboarding and AI-assisted work can lose fidelity unless external Obsidian sources are read separately.

## Problem

The project currently depends on a split-brain documentation model:

- primary source material lives in Obsidian
- the workspace does not contain a complete local mirror of the minimum required context

This increases onboarding cost and raises the odds of future sessions operating on stale or partial assumptions.

## Why this matters now

The more the project depends on external context for architecture and workflow decisions, the more important it becomes to preserve a reliable minimum reading set inside the working environment.

This is especially relevant for AI-assisted sessions, handoffs and quick technical triage.

## Proposed scope

- identify the minimum required source documents for reliable project onboarding
- ensure the workspace contains a concise, maintained summary of those documents
- document which files must always be read during session pre-flight
- review broken or missing references that degrade local comprehension
- keep a clear distinction between source-of-truth docs and workspace-friendly summaries

## Out of scope

- full automated synchronization from Obsidian into the repository
- complete documentation reorganization
- replacing Obsidian as the primary documentation home

## Acceptance criteria

- there is a reliable minimum context package available from the workspace
- onboarding material clearly points to the source documents that matter most
- broken or misleading references in the minimum reading chain are resolved or documented
- future sessions can bootstrap context with lower token and time cost

## Technical notes

- Avoid creating two competing sources of truth.
- The workspace should contain a concise operational summary, not an uncontrolled documentation fork.
- Pre-flight onboarding material should remain opinionated and explicit.

## Dependencies

- no code dependency
- can run in parallel with product and platform work

## Risks

- poor mirroring strategy may create drift between summary docs and the Obsidian source of truth
- over-documenting the workspace may reintroduce sprawl instead of reducing it

## Validation expectations

- local reading chain is complete for required onboarding files
- onboarding prompt points to existing, reachable files
- summary docs remain concise and operationally useful

## Documentation impact

- Checklist de Pre-Voo.md
- Contexto Consolidado.md
- any contribution docs affected by onboarding changes

## Evidence

- `Contexto.md`
- linked Obsidian references used during onboarding

---

## Suggested labels

- `p0`
- `p1`
- `p2`
- `architecture`
- `telegram`
- `payments`
- `webhooks`
- `security`
- `tests`
- `docs`
- `multi-tenant`

## Suggested workflow

1. Publish these as GitHub issues, not PRs.
2. Link each issue to a backlog item when available.
3. Only open a PR once implementation starts on a real branch.
4. Reference the issue from the PR using closing keywords when work is ready.
