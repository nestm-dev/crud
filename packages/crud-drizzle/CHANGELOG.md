# @nestm/crud-drizzle

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

### Minor Changes

- c3cf5ac: Add an operation-wide transaction isolation requirement so scopes, lifecycle
  hooks, validators, mappings, projections, and persistence start inside a
  sufficiently strong transaction. This prevents snapshot-sensitive nested work
  from attempting an unsafe mid-transaction isolation promotion, including during
  create operations.

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
