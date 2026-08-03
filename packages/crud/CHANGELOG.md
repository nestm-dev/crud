# @nestm/crud

## 0.1.0-alpha.2

### Minor Changes

- b50c6ef: Emit versioned CRUD filter metadata and add an optional Swagger UI condition
  builder with field, operator, value, and add/remove controls while preserving
  the existing bracket-query HTTP contract.

## 0.1.0-alpha.1

### Minor Changes

- d09fda7: Allow generated routes to carry opaque Nest decorators, expose retryable adapter
  conflicts, and add application-owned Drizzle transaction runners with fail-closed
  native row predicates and snapshot-consistent counted lists. Add an explicit,
  strict-by-default binding seam for required create fields supplied by CRUD scopes.
  Keep scope create values insert-only, support immutable scope-owned insert fields,
  make runner commit ownership and effective transaction state explicit, and recognize
  adapter errors structurally across duplicated package copies.
