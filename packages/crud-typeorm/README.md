# `@nestm/crud-typeorm`

PostgreSQL-first TypeORM 1.1 adapter for [`@nestm/crud`](../crud). The adapter
compiles the neutral CRUD predicate tree to a TypeORM query builder with named
parameters, runs mutations in consumer-owned transactions, supports composite
identities, and sanitizes database errors.

The `0.1` alpha is certified for PostgreSQL only.

```sh
pnpm add @nestm/crud@alpha @nestm/crud-typeorm@alpha typeorm pg
```

```ts
import { bindTypeOrmCrud, createTypeOrmCrudAdapter } from "@nestm/crud-typeorm";

const usersAdapter = createTypeOrmCrudAdapter({
	repository: usersRepository,
	columns: { id: "id", email: "email", createdAt: "createdAt" },
});

const usersBinding = bindTypeOrmCrud({
	resource: users,
	fields: ["id", "email", "createdAt"],
	adapter: { useValue: usersAdapter },
	mappings: {
		create: (input) => input,
		update: (input) => input,
		// Maps framework-generated scope/soft-delete values to entity keys.
		persistence: (values) => values,
		response: (record, relations) => ({ ...record, ...relations }),
	},
});
```

`columns` maps CRUD logical fields to entity property paths. It must cover every
field listed by the binding. `mappings.persistence` is separate because scopes
and soft delete generate logical values outside create/update input mappings.
Native `rowPredicate` parameters must not use the adapter-reserved `crud_<n>`
names; a collision is rejected before the statement executes.

## Selected records

Use TypeORM's native `select` shape when an entity contains columns that a CRUD
resource must never hydrate:

```ts
const connectionsAdapter = createTypeOrmCrudAdapter({
	repository: connectionsRepository,
	columns: {
		id: "id",
		ownerId: "ownerId",
		disabledTools: "disabledTools",
	},
	select: {
		id: true,
		ownerId: true,
		disabledTools: true,
	},
});
```

An explicit selection is an allowlist for database columns selected or
`RETURNING`-hydrated by create, read, list, update, and delete. All primary
columns must be selected, every nested branch must contain a scalar column, and
relations, virtual columns, tree entities, and base single-table-inheritance
repositories are rejected. A concrete STI child repository is supported.
Embedded columns use the ordinary TypeORM object shape. The adapter's record
type is narrowed to the selected shape, while create and update mappings still accept
`DeepPartial<Entity>`. Selection is not a write allowlist and does not restrict
columns used by predicates or ordering. Calling `getField()` for an unselected
logical field fails instead of returning an ambiguous `undefined`.

TypeORM still constructs entity instances. Class field initializers,
constructors, and `@AfterLoad` listeners can therefore create own properties
that were not read from the database; do not spread selected records when key
absence itself is a response-security requirement. Selected reads run
`@AfterLoad` with a partial entity, while manual mutation `RETURNING` hydration
does not run `@AfterLoad`.

Selected mutations deliberately use `InsertQueryBuilder`,
`UpdateQueryBuilder`, and `DeleteQueryBuilder` with an explicit `RETURNING`
allowlist. This prevents `Repository.save()` and `Repository.remove()` from
issuing TypeORM's implicit full-entity reload. Database defaults,
`@UpdateDateColumn`, `@VersionColumn`, constraints, triggers, and database
cascades still apply. Inserts instantiate the entity and retain constructor
defaults and query-builder `@BeforeInsert`/`@AfterInsert` events. ORM relation
cascades and full-entity update/delete listener semantics from `save()`/`remove()`
do not; query-builder subscribers can receive partial or absent entities.
`@AfterInsert` runs on the input instance without generated values; its in-memory
decorations are not copied to the separately hydrated returned record.
Updates containing only `undefined`, empty embedded objects, or non-updatable
columns are treated as no-ops. Omit `select` to preserve the legacy full-entity
path.

## Atomic upsert

When a resource enables the core `upsert` operation, configure its binding with
the complete TypeORM primary identity and the exact persistence fields that may
change on conflict:

```ts
const viewerBindings = bindTypeOrmCrud({
	resource,
	fields,
	adapter: { useValue: viewerBindingsAdapter },
	upsert: {
		conflictFields: ["artifactId", "viewerUserId", "mcpServerId"],
		overwriteFields: ["toolPrefix", "allowedTools"],
	},
	mappings: {
		// The final row also receives scope-owned fields through scopeCreate.
		upsert: (id, input) => ({ ...id, ...input }),
		// ...the other ordinary mappings
	},
});
```

Both lists contain TypeORM entity property paths, not public CRUD field names or
database column names. `conflictFields` must be non-empty, map exactly once to
every primary column, and have non-null values in the final scoped insert row.
`overwriteFields` must be unique, non-primary scalar columns that TypeORM permits
on both insert and update. This explicit allowlist prevents an upsert from
silently replacing immutable ownership or secret fields.

The adapter emits one PostgreSQL `INSERT ... ON CONFLICT (...) DO UPDATE ...
WHERE ... RETURNING ...` statement. The normal CRUD predicate and native
`rowPredicate` are both compiled into the conflict-update `WHERE`; a conflicting
row that fails either predicate is left unchanged and returns `null`. PostgreSQL
does not apply that update predicate to a new insert. The CRUD scope must
materialize insert ownership fields, while database RLS and constraints remain
the final insert boundary.

Upsert never performs a pre-read, `save()`, or reload. With `select`, its
`RETURNING` list and hydrated record contain only selected scalar columns. Without
`select`, it explicitly returns and hydrates every physical scalar metadata
column. Tree entities and base single-table-inheritance repositories are rejected
because their primitive-DML semantics are not safe; concrete STI child
repositories remain supported.

The statement uses TypeORM's insert query-builder lifecycle: entity construction
and insert listeners run for the proposed row, and PostgreSQL triggers/defaults
run normally. It does not emulate `Repository.save()` relation cascades or
full-entity update listeners. The returned record is separately hydrated from
`RETURNING`, so in-memory decorations made by an after-insert listener on the
proposed entity are not copied to it.

The binder accepts Nest `useValue`, `useClass`, `useExisting`, and `useFactory`
adapter providers. For an injected repository, construct the adapter in a
`useFactory` and list the repository token in `inject`. The package never
creates, initializes, or destroys a `DataSource` or `Repository`; their lifecycle
belongs to the consuming application.

Unique PostgreSQL violations map to `409`, other database constraints to `400`,
and unrecognized failures to a sanitized `500` without exposing the raw ORM
error. The `0.1` alpha is not certified for non-PostgreSQL TypeORM drivers.

License: BSD-3-Clause.
