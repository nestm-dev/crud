---
"@nestm/crud": minor
"@nestm/crud-memory": minor
"@nestm/crud-typeorm": minor
"@nestm/crud-drizzle": minor
"@nestm/crud-prisma": minor
---

Require every resource to declare one authoritative `fields` tuple and remove
the duplicated `fields` option from bindings. IDs, nested path mappings, query
filters/search/sort, soft delete, relations, scopes, cursor bindings, mapping
callbacks, predicates, and ordering now autocomplete that vocabulary and reject
unknown names.

Preserve persistence-field vocabularies across adapters and bindings. Upsert
conflict and overwrite tuples now autocomplete adapter fields, including typed
TypeORM property paths. Memory uniqueness constraints, TypeORM references,
Drizzle columns and record keys, and Prisma identity/model/record mappings are
derived from their corresponding persistence models.
