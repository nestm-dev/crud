---
"@nestm/crud": minor
"@nestm/crud-typeorm": minor
---

Add first-class nested resources whose collection-path parameters are validated,
bound to persistence fields, included in operation contexts, and enforced on
collection and item operations without coupling headless services to HTTP.

Add a first-class atomic upsert operation across resource contracts, lifecycle
hooks, scopes, bindings, services, generated controllers, and adapter
capabilities. Upsert bindings declare complete persistence conflict fields and an
explicit overwrite allowlist, while the adapter conflict branch must enforce the
normal resource and scope predicate.

Certify TypeORM upsert on PostgreSQL with a single `INSERT ... ON CONFLICT ... DO
UPDATE ... WHERE ... RETURNING` statement. The adapter validates the complete
physical primary identity, rejects unsafe overwrite fields and unsupported entity
models, combines native row authorization with CRUD predicates, preserves narrow
selected-record hydration, and performs no pre-read or reload.
