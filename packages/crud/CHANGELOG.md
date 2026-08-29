# @nestm/crud

## 0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- 67503c2: Declare stable NestJS 12 peer support and certify the Prisma adapter against Prisma 7.10.

## 0.1.0-alpha.9

### Minor Changes

- 9f5135f: Allow binding mappers to return Standard Schema optional properties directly;
  CRUD removes explicitly undefined optional values before invoking adapters.
  Make `mappings.persistence` optional when the framework contributes no scope or
  soft-delete update values, while failing closed for non-empty unmapped values.

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

## 0.1.0-alpha.6

## 0.1.0-alpha.5

### Minor Changes

- 5478180: Add a `generateControllers: false` option to `CrudModule.forFeature()` for
  headless feature registrations. Headless features still register bindings,
  adapters, services, relations, scopes, hooks, projections, and registry entries,
  and they continue to export each resource's `CrudService` token for injection by
  fully custom compatibility controllers.

  The option defaults to `true`, preserving generated controllers and their route
  collision validation for existing feature registrations.

  HTTP exceptions mapped from adapter conflicts and constraints now retain the
  original `CrudAdapterError` as their `cause`, so compatibility facades can
  distinguish retryable transaction conflicts from domain conflicts without
  parsing response messages.

## 0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- dcd4f34: Add batch response projections, for response fields the persistence adapter cannot select.

  Aggregates are the motivating case: `artifactCount` on a project, `memberCount` on an
  organization. An adapter selects from one table with no join and no `groupBy`, so these are
  invisible to it by design — which is what previously made otherwise CRUD-shaped resources not
  worth generating.

  `CrudLifecycleHook` could not fill the gap: it is mutation-only, with no `afterList`. And a
  per-record hook would be the wrong shape anyway — one aggregate query per row is exactly the N+1
  this avoids.

  ```ts
  @Injectable()
  export class ProjectArtifactCounts implements CrudProjection {
  	constructor(private readonly projects: ProjectsRepository) {}

  	async project(records: readonly ProjectRow[]) {
  		const counts = await this.projects.countArtifactsByProject(records.map((r) => r.id));
  		return records.map((record) => ({ artifactCount: counts.get(record.id) ?? 0 }));
  	}
  }

  defineCrudResource({
  	// …
  	projections: [ProjectArtifactCounts],
  });
  ```

  `project` receives the whole page and returns one entry per record, index-aligned. Several
  projections merge in declaration order. Their merged output arrives as an optional third argument
  to `mappings.response(record, relations, projected?)`.

  Adapter-neutral — no adapter change and no conformance-suite change. Fully additive:

  - A two-argument `response` implementation stays assignable where a three-argument one is
    expected, so every existing binding compiles untouched.
  - A resource declaring no projections passes `undefined` as the third argument, so bindings see
    exactly the previous behaviour.
  - `projections` is appended last on the `CrudService` constructor and defaults to `[]`, so direct
    construction keeps working.

  Projections run on every path that maps a record — `list`, `read`, and the create/update/restore
  responses — so one response schema does not produce two shapes depending on the verb. Relation
  targets are projected too, in one batch per page, piggybacking on the single query `loadRelation`
  already issues; without that, an included payload would silently lack fields the same resource
  carries at the top level.

  A projection returning a different number of entries than it was given raises a 500 rather than
  silently dropping the tail.

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
