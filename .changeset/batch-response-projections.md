---
"@nestm/crud": minor
---

Add batch response projections, for response fields the persistence adapter cannot select.

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
