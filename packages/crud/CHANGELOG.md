# @nestm/crud

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
