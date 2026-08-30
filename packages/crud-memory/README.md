# `@nestm/crud-memory`

Transactional in-memory adapter for `@nestm/crud`. It is
suited to tests, examples, and ephemeral NestJS services, and implements the
same predicate, pagination, composite-ID, and rollback contract as the SQL
adapters. Transactions use copy-on-write state, so a thrown hook or adapter
operation never leaks a partially committed mutation.

```ts
import { randomUUID } from "node:crypto";
import { bindMemoryCrud } from "@nestm/crud-memory";

const usersBinding = bindMemoryCrud({
	resource: usersResource,
	initialRecords: [{ id: "1", name: "Ada" }],
	unique: [["id"]],
	mappings: {
		create: (input) => ({ ...input, id: randomUUID() }),
		// Nested path values and application scope values can be mapped separately
		// through scopeCreate when they own required insert fields.
		update: (input) => input,
		// Maps scope and soft-delete logical values to stored record keys.
		persistence: (values) => values,
		response: (record, relations) => ({ ...record, ...relations }),
	},
});
```

Pass `store: new MemoryCrudStore(...)` when tests need to inspect or reset
committed state. The convenient binder creates an adapter around the supplied
or package-created store; it does not open an external connection. The
`adapter` override accepts Nest's `useValue`, `useClass`, `useExisting`, and
`useFactory` provider forms when an application-managed adapter is preferable.

Like the SQL binders, `bindMemoryCrud` accepts `scopeCreateFields` plus
`mappings.scopeCreate`. Use them for required insert fields owned by a nested
collection path or application scope rather than the request body.

The resource's `fields` names are logical API fields used by filters, ordering,
IDs, scopes, soft deletion, and relations. For non-object records, provide `createRecord`,
`updateRecord`, and `getField`. Declare `unique` logical-field tuples to exercise
the same `409` conflict path used by SQL unique constraints.

The bundled memory adapter does not advertise atomic upsert. The binder forwards
generic upsert metadata only when an application supplies a custom capable
adapter; ordinary memory resources that enable upsert fail at bootstrap.
