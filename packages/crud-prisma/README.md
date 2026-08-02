# `@nestm/crud-prisma`

PostgreSQL-first Prisma 7.9 adapter for [`@nestm/crud`](../crud). It compiles the
neutral CRUD AST to generated delegate `where` and `orderBy` inputs, uses
interactive transactions, handles native compound unique selectors, and
sanitizes Prisma/database failures.

The `0.1` alpha is certified for PostgreSQL only.

```sh
pnpm add @nestm/crud@alpha @nestm/crud-prisma@alpha @prisma/client
```

```ts
import { bindPrismaCrud, createPrismaCrudAdapter } from "@nestm/crud-prisma";

const usersAdapter = createPrismaCrudAdapter({
	client: prisma,
	delegate: (client) => client.user,
	identity: (record: User) => ({ id: record.id }),
	nonNullableFields: ["id", "email", "createdAt"],
});

const usersBinding = bindPrismaCrud({
	resource: users,
	fields: ["id", "email", "createdAt"],
	adapter: { useValue: usersAdapter },
	mappings: {
		create: (input) => input,
		update: (input) => input,
		// Maps framework-generated scope/soft-delete values to Prisma data keys.
		persistence: (values) => values,
		response: (record, relations) => ({ ...record, ...relations }),
	},
});
```

For a compound key, `identity` returns its generated Prisma selector, for example
`{ tenantId_slug: { tenantId: record.tenantId, slug: record.slug } }`. `fields`
maps CRUD logical fields to Prisma model fields, while `recordKeys` maps those
logical fields to returned-record keys.

Declare logical `nonNullableFields` when those fields enable the `isnull` filter. This lets the
adapter compile `isnull=true|false` to a constant false/true predicate without sending an invalid
`null` filter to a required Prisma model field.

The binder accepts Nest `useValue`, `useClass`, `useExisting`, and `useFactory`
adapter providers. A factory can inject an application-owned `PrismaClient`;
this package never constructs it and never calls `$connect` or `$disconnect`.

Prisma unique violations map to `409`, supported database/model constraints to
`400`, and unrecognized failures to a sanitized `500`. The `0.1` alpha is
certified with Prisma's PostgreSQL connector only.

License: BSD-3-Clause.
