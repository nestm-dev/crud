---
"@nestm/crud-typeorm": minor
---

Replace `TypeOrmCrudTransactionIsolationLevel`'s lowercase string enum with a
same-name const object and derived union type whose supported values use
TypeORM's native uppercase `IsolationLevel` spelling. Member access remains
unchanged, while values can now pass directly to TypeORM transaction APIs.
