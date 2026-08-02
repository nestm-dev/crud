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

The binder accepts Nest `useValue`, `useClass`, `useExisting`, and `useFactory`
adapter providers. For an injected repository, construct the adapter in a
`useFactory` and list the repository token in `inject`. The package never
creates, initializes, or destroys a `DataSource` or `Repository`; their lifecycle
belongs to the consuming application.

Unique PostgreSQL violations map to `409`, other database constraints to `400`,
and unrecognized failures to a sanitized `500` without exposing the raw ORM
error. The `0.1` alpha is not certified for non-PostgreSQL TypeORM drivers.

License: BSD-3-Clause.
