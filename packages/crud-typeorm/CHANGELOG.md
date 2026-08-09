# @nestm/crud-typeorm

## 0.1.0-alpha.4

### Minor Changes

- a849597: Bring the TypeORM adapter to parity with the Drizzle one for scoped, authorized
  resources. Add application-owned transaction runners with explicit access mode,
  isolation level and commit ownership, all validated fail-closed: a runner that
  weakens the requested access mode, drops a required repeatable-read snapshot, or
  does not own the real commit is refused rather than trusted.

  Add fail-closed native row predicates applied to every read, update and delete.
  The predicate receives the query alias as an argument instead of inferring it from
  the builder it lands on — two entities that share a column name would otherwise
  produce valid SQL against the wrong table, which returns plausible rows and no
  error. A predicate that resolves to anything but `Brackets` aborts the statement
  before it reaches the database.

  Add `scopeCreateFields` to `bindTypeOrmCrud`, so scope-owned insert fields are
  supplied through `mappings.scopeCreate` and never have to be expressible in
  `mappings.persistence`, which the update path shares. Note that, unlike the
  Drizzle binder, this does not relax the create mapper's types: TypeORM create
  values are already `DeepPartial<Entity>`.

  Classify SQLSTATE `40001` and `40P01` as retryable conflicts, matching the Drizzle
  adapter; under repeatable-read isolation they previously surfaced as `unknown`.

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
