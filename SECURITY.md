# Security policy

Please do not open public issues for suspected vulnerabilities. Report them
privately to the maintainers of the `nestm` organization, including a minimal
reproduction, affected versions, and expected impact.

This alpha is built around several security invariants:

- Query fields and operators are allowlisted and values are parsed once through
  their Standard Schema.
- Database adapters use parameterized ORM/driver APIs.
- Scope predicates apply below controller orchestration, including relation and
  mutation reads.
- Scope-owned create fields are explicitly declared, must be materialized by
  the scope-create mapping, and overwrite API-mapped values only before insert.
- Scope `createValues` are never merged into updates; update overwrites require
  the distinct, explicit `updateValues` channel.
- Drizzle native row predicates are combined with, never substituted for, CRUD
  predicates and fail closed when configured without an expression.
- Application transaction runners receive explicit read/write, isolation, and
  commit-ownership requirements; counted Drizzle lists pin rows and totals to
  one repeatable-read transaction, while mutation runners must own the real
  commit rather than a savepoint.
- Scope-hidden records return `404`.
- Raw ORM/driver errors are never returned to clients.
- Production cursors require HMAC-SHA-256 with at least 32 bytes of key material.

The `InsecureCrudCursorCodec` export under `@nestm/crud/testing` is intentionally
unsafe and must never be used by a deployed application.
