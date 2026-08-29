# @nestm/crud-typeorm

## 0.1.0-alpha.13

### Minor Changes

- d93753e: Automatically copy declared same-name scope-create values so ordinary bindings no
  longer need a mapper or repetitive unknown-value guards. Custom renamed mappings
  continue to receive honest `unknown` values.

  Add autocomplete-friendly TypeORM column definitions with inline selection,
  wildcard mapping, typed exclusions, an isolation-level enum, and a single nested
  transaction object containing both requirements and the application runner.

### Patch Changes

- Updated dependencies [d93753e]
  - @nestm/crud@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [856fe97]
  - @nestm/crud@0.1.0-alpha.12

## 0.1.0-alpha.11

### Minor Changes

- b9b990d: Allow atomic PostgreSQL upserts to target a complete non-deferrable TypeORM
  unique constraint or non-partial unique index in addition to the primary
  identity. This supports entities with generated primary keys and domain-owned
  alternate identities while preserving scoped conflict-update authorization,
  explicit overwrite allowlists, and single-statement execution.

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

### Minor Changes

- 213a94d: Add ordered, transaction-bound CRUD mutation validators with operation-specific
  input, identity, session, and typed scope-fact contexts. Validators
  run after before-hook input transformations and after source visibility checks,
  while failures roll back and preserve application HTTP exceptions.

  Add opaque typed scope facts for carrying an authorized parent or other derived
  state through later mutation phases without exposing a mutable map or leaking
  transaction-local state into after-commit events.

  Add TypeORM reference checks that reuse the source CRUD mutation's active
  transaction, apply a caller-provided identity-and-visibility predicate, and issue
  a raw `SELECT 1 ... FOR SHARE` without hydrating the referenced entity or starting
  a nested transaction.

### Patch Changes

- Updated dependencies [213a94d]
  - @nestm/crud@0.1.0-alpha.8

## 0.1.0-alpha.7

### Minor Changes

- be80eb4: Add first-class nested resources whose collection-path parameters are validated,
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

### Patch Changes

- Updated dependencies [be80eb4]
  - @nestm/crud@0.1.0-alpha.7

## 0.1.0-alpha.6

### Minor Changes

- 71a3d4c: Add opt-in, type-narrowed TypeORM record selection. An explicit `select` object
  now restricts every hydrated create/read/list/update/delete record, rejects
  missing primary columns, and makes unselected fields unavailable to binding
  response mappings.

  Selected mutations use direct query builders with predicate-authorizing primary
  key subqueries and explicit `RETURNING` columns, preventing TypeORM's implicit
  `save()`/`remove()` reload from hydrating excluded columns. Scalar selection is
  validated strictly, inserts retain entity construction and insert listeners,
  and native predicate parameter collisions fail closed.

### Patch Changes

- @nestm/crud@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [5478180]
  - @nestm/crud@0.1.0-alpha.5

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
