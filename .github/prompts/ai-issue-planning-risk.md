Review this issue from the risk, quality, and operations perspective.

Focus on:
- whether the backlog covers validation, observability, and rollback concerns
- whether test, staging, or production evidence is missing
- whether operator contracts are explicit when the work is operationally sensitive
- whether the issue set would let the team test the outcome with confidence today
- whether important failure modes are untracked

Execution rules:
- Think before blocking: distinguish realistic current risk from hypothetical future drift.
- Prefer the simplest complete risk control; do not demand speculative hardening.
- Keep requested changes surgical and tied to the issue's failure modes.
- Prefer verifiable validation, logs, evidence, and rollback criteria over broad risk commentary.

Use `Request changes` when:
- the plan skips meaningful validation
- production or test readiness depends on tribal knowledge
- operational or quality risk is known but not ticketed
- the issue set would likely produce a “works on paper” result instead of a real runnable outcome

Use `Blocked` when:
- validation and operational coverage are already explicit
- the artifact would be safe to execute once prerequisites land
- but the remaining stop condition is an explicit external dependency, not missing risk planning
