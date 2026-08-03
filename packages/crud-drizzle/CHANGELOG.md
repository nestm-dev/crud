# @nestm/crud-drizzle

## 0.1.0-alpha.1

### Minor Changes

- d09fda7: Allow generated routes to carry opaque Nest decorators, expose retryable adapter
  conflicts, and add application-owned Drizzle transaction runners with fail-closed
  native row predicates and snapshot-consistent counted lists. Add an explicit,
  strict-by-default binding seam for required create fields supplied by CRUD scopes.
  Keep scope create values insert-only, support immutable scope-owned insert fields,
  make runner commit ownership and effective transaction state explicit, and recognize
  adapter errors structurally across duplicated package copies.

### Patch Changes

- Updated dependencies [d09fda7]
  - @nestm/crud@0.1.0-alpha.1
