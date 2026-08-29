---
"@nestm/crud-typeorm": minor
---

Allow atomic PostgreSQL upserts to target a complete non-deferrable TypeORM
unique constraint or non-partial unique index in addition to the primary
identity. This supports entities with generated primary keys and domain-owned
alternate identities while preserving scoped conflict-update authorization,
explicit overwrite allowlists, and single-statement execution.
