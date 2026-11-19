# @nestm/crud-prisma

## 0.1.0-alpha.17

### Patch Changes

- 92faaaf: Drop the unused `@nestm/standard-schema` peer from `@nestm/crud`; Nest 12's native
  `StandardSchemaValidationPipe` and serializer are enough. Test against NestJS 12.5, Swagger 12.1,
  TypeORM 1.1.3, and PostgreSQL 18, with a pnpm catalog keeping every workspace importer on one
  `@nestjs/core`/`typeorm` instance (the cause of the Nest ≥ 12.0.3 `Reflector` resolution failure
  and the TypeORM duplicate-instance typecheck errors).
- 92faaaf: Add first-class optimistic concurrency with `concurrency: { field: "version" }`. Responses carry
  `ETag`; PATCH, PUT, and DELETE require `If-Match` (absent → 428, stale → 412) and compare it with
  the row read under a write lock, then pin the UPDATE/DELETE to that version so a lost race also
  answers 412. Conditional PUT accepts `If-None-Match: *` for create-only. Adapters receive an
  advisory `lock` on `findOne` (implemented by TypeORM), the conformance kit gains a
  version-guard case, and Swagger documents the headers and the 412/428 responses.
- 92faaaf: Add a pluggable per-resource list contract. `query.schema` binds one Standard Schema for the
  whole list query through Nest's `@Query({ schema })` (validated by Nest, documented by Swagger),
  and `query.toListQuery(parsed)` maps it to a parser-independent `CrudListRequest` (predicate AST,
  order, offset page or keyset cursor). `CrudService.listQuery()` runs such a request directly,
  skipping every grammar. The bracket grammar stays the default whenever `query.schema` is absent.
  Bracket resources can rename `page`/`limit`/`after` with `query.pagination.parameters`, and any
  resource can replace the page `meta` with `query.pagination.meta` formatters whose schemas drive
  response validation and OpenAPI.
- Updated dependencies [92faaaf]
- Updated dependencies [92faaaf]
- Updated dependencies [92faaaf]
  - @nestm/crud@0.1.0-alpha.17

## 0.1.0-alpha.16

### Patch Changes

- 12d9acd: Add opt-in PostgreSQL full-text search with weighted fields, primary-field ranking,
  plain/websearch/prefix query modes, and offset pagination. Export the TypeORM search
  and vector compilers for custom repositories and consumer-owned GIN indexes. Reject
  unsupported adapters and rank-ordered cursor queries instead of silently falling back.
- Updated dependencies [12d9acd]
  - @nestm/crud@0.1.0-alpha.16

## 0.1.0-alpha.15

### Minor Changes

- daf0bee: Require every resource to declare one authoritative `fields` tuple and remove
  the duplicated `fields` option from bindings. IDs, nested path mappings, query
  filters/search/sort, soft delete, relations, scopes, cursor bindings, mapping
  callbacks, predicates, and ordering now autocomplete that vocabulary and reject
  unknown names.

  Preserve persistence-field vocabularies across adapters and bindings. Upsert
  conflict and overwrite tuples now autocomplete adapter fields, including typed
  TypeORM property paths. Memory uniqueness constraints, TypeORM references,
  Drizzle columns and record keys, and Prisma identity/model/record mappings are
  derived from their corresponding persistence models.

### Patch Changes

- Updated dependencies [daf0bee]
  - @nestm/crud@0.1.0-alpha.15

## 0.1.0-alpha.14

### Patch Changes

- @nestm/crud@0.1.0-alpha.14

## 0.1.0-alpha.13

### Patch Changes

- Updated dependencies [d93753e]
  - @nestm/crud@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [856fe97]
  - @nestm/crud@0.1.0-alpha.12

## 0.1.0-alpha.11

### Patch Changes

- @nestm/crud@0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- 67503c2: Declare stable NestJS 12 peer support and certify the Prisma adapter against Prisma 7.10.
- Updated dependencies [67503c2]
  - @nestm/crud@0.1.0-alpha.10

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [9f5135f]
  - @nestm/crud@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies [213a94d]
  - @nestm/crud@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [be80eb4]
  - @nestm/crud@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- @nestm/crud@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [5478180]
  - @nestm/crud@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- @nestm/crud@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [dcd4f34]
  - @nestm/crud@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [b50c6ef]
  - @nestm/crud@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- d09fda7: Allow generated routes to carry opaque Nest decorators, expose retryable adapter
  conflicts, and add application-owned Drizzle transaction runners with fail-closed
  native row predicates and snapshot-consistent counted lists. Add an explicit,
  strict-by-default binding seam for required create fields supplied by CRUD scopes.
  Keep scope create values insert-only, support immutable scope-owned insert fields,
  make runner commit ownership and effective transaction state explicit, and recognize
  adapter errors structurally across duplicated package copies.
- Updated dependencies [d09fda7]
  - @nestm/crud@0.1.0-alpha.1
