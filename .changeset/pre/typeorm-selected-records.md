---
"@nestm/crud-typeorm": minor
---

Add opt-in, type-narrowed TypeORM record selection. An explicit `select` object
now restricts every hydrated create/read/list/update/delete record, rejects
missing primary columns, and makes unselected fields unavailable to binding
response mappings.

Selected mutations use direct query builders with predicate-authorizing primary
key subqueries and explicit `RETURNING` columns, preventing TypeORM's implicit
`save()`/`remove()` reload from hydrating excluded columns. Scalar selection is
validated strictly, inserts retain entity construction and insert listeners,
and native predicate parameter collisions fail closed.
