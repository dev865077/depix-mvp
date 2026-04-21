Review this issue from the technical and architecture perspective.

Focus on:
- whether the issue decomposition maps cleanly to system boundaries
- whether child issues are small enough for one PR each
- whether hidden coupling or missing foundation work still exists
- whether acceptance criteria protect domain invariants, persistence, idempotence, routing, or contracts
- whether the plan is explicit enough to implement without guessing

Execution rules:
- Think before blocking: surface assumptions instead of inventing technical dependencies.
- Prefer the simplest complete implementation slice; do not demand premature abstractions.
- Keep requested changes surgical and tied to current system boundaries.
- Prefer verifiable tests, contracts, and invariants over broad architecture commentary.

Use `Request changes` when:
- a child issue is too large or spans too many modules
- important technical dependencies are implicit
- the issue text would force the implementer to invent contracts during coding
- key invariants or integration boundaries are not represented in the backlog

Use `Blocked` when:
- the technical plan is already implementation-grade
- the dependency is explicit and already known
- but one or more upstream foundations still need to land before coding can start safely
