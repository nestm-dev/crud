# `@nestm/crud`

Type-safe, generated CRUD controllers for NestJS 12, with a stable adapter SPI
for memory, TypeORM, Drizzle ORM, and Prisma.

> [!CAUTION]
> This project remains prerelease software. The package API may change between
> alpha releases. The ORM packages certify PostgreSQL only in the first alpha.

## Packages

| Package               | Purpose                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `@nestm/crud`         | Resources, generated controllers, orchestration, query AST, scopes, hooks, Swagger, and adapter SPI |
| `@nestm/crud-memory`  | Copy-on-write transactional adapter for tests and ephemeral services                                |
| `@nestm/crud-typeorm` | PostgreSQL adapter for TypeORM 1.1                                                                  |
| `@nestm/crud-drizzle` | PostgreSQL adapter for Drizzle ORM 0.45                                                             |
| `@nestm/crud-prisma`  | PostgreSQL adapter for Prisma 7.10                                                                  |

By default, the package generates ordinary Nest controllers during synchronous
`CrudModule.forFeature()` construction. Set `generateControllers: false` for a
headless feature that registers and exports its CRUD services without generated
routes. The package uses public dynamic-module and custom-provider APIs; it does
not install controllers after bootstrap and never registers guards, pipes,
interceptors, or filters globally.

## Install

```sh
pnpm add @nestm/crud@alpha @nestm/crud-memory@alpha
pnpm add @nestm/standard-schema@alpha @standard-schema/spec @nestjs/swagger
```

Install and pin the stable NestJS 12 packages tested by your application. This
workspace currently tests `12.0.1`. `@nestm/standard-schema` and `@nestjs/swagger`
are required peers, not optional integrations.

## Quick start

```ts
import { Module } from "@nestjs/common";
import { CrudModule, crudOperations, defineCrudResource } from "@nestm/crud";
import { bindMemoryCrud } from "@nestm/crud-memory";
import { StandardSchemaModule } from "@nestm/standard-schema";
import { z } from "zod";

const UserId = z.object({ id: z.coerce.number().int().positive() });
const CreateUser = z.object({
	id: z.number().int().positive(),
	name: z.string().trim().min(1),
});
const UpdateUser = z.object({ name: z.string().trim().min(1).optional() });
const UserResponse = z.object({
	id: z.number().int().positive(),
	name: z.string(),
});

export const users = defineCrudResource({
	fields: ["id", "name"],
	name: "users",
	path: "users",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: UserId,
		create: CreateUser,
		update: UpdateUser,
		response: UserResponse,
	},
	operations: crudOperations.all(),
	query: {
		filters: {
			id: { schema: z.coerce.number(), operators: ["eq", "in"] },
			name: { schema: z.string(), operators: ["eq", "icontains"] },
		},
		sort: {
			fields: ["id", "name"],
			default: ["id"],
			cursor: ["id", "name"],
		},
		search: { fields: ["name"] },
		pagination: { offset: true, cursor: true },
	},
});

const usersBinding = bindMemoryCrud({
	resource: users,
	unique: [["id"]],
	mappings: {
		create: (input) => input,
		update: (input) => input,
		response: (record) => record,
	},
});

@Module({
	imports: [
		StandardSchemaModule.forRoot(),
		CrudModule.forRootAsync({
			useFactory: () => ({
				// At least 32 bytes. Read this from validated application config.
				cursor: { secret: process.env.CRUD_CURSOR_SECRET! },
			}),
		}),
		CrudModule.forFeature({ resources: [usersBinding] }),
	],
})
export class AppModule {}
```

Applications must import `StandardSchemaModule.forRoot()` once. It installs the
Nest-native Standard Schema request validation and response serialization used
by generated controllers; bootstrap fails when CRUD resources are registered
without both integrations enabled. Do not register a second copy of Nest's
global Standard Schema pipe or serializer.

Set up `SwaggerModule` normally. Generated handlers carry tags, operation IDs,
response statuses, request/response schemas, path parameters, query parameters,
and Nest error responses. If the schema vendor needs a custom Nest Swagger
converter, compose it so the generated list wrapper is also converted:

```ts
import { SwaggerModule } from "@nestjs/swagger";
import { withCrudStandardSchemaConverter } from "@nestm/crud";

const document = SwaggerModule.createDocument(app, swaggerConfig, {
	standardSchemaConverter: withCrudStandardSchemaConverter(vendorSchemaConverter),
});
```

Schemas with native Standard JSON Schema output do not need a vendor converter.

### Interactive filter builder

Generated list operations with configured filters include versioned
`x-nestm-crud-query` metadata in addition to their normal OpenAPI query
parameters. Install the optional Swagger UI plugin to replace the flat filter
inputs with field/operator/value rows and `+` / `−` controls:

```ts
import { NestMCrudQuerySwaggerUiPlugin, NESTM_CRUD_SWAGGER_UI_CSS } from "@nestm/crud/swagger-ui";

SwaggerModule.setup("docs", app, document, {
	swaggerOptions: {
		plugins: [NestMCrudQuerySwaggerUiPlugin],
	},
	customCss: NESTM_CRUD_SWAGGER_UI_CSS,
});
```

The builder supports only the filter operations already declared by the
resource. Rows are combined with `AND`; list and range values remain
comma-separated. It writes into the existing
`filter[field][operator]` parameters, so enabling the plugin does not change
the HTTP contract, parser, predicate model, or persistence adapters. Without the
plugin, Swagger UI continues to show the ordinary generated parameters.

## HTTP contract

| Operation | Route                     | Response                |
| --------- | ------------------------- | ----------------------- |
| Create    | `POST /users`             | `201`, response DTO     |
| List      | `GET /users`              | `200`, `{ data, meta }` |
| Read      | `GET /users/:id`          | `200`, response DTO     |
| Update    | `PATCH /users/:id`        | `200`, response DTO     |
| Upsert    | `PUT /users/:id`          | `200`, response DTO     |
| Delete    | `DELETE /users/:id`       | `204`, no body          |
| Restore   | `POST /users/:id/restore` | `200`, response DTO     |

Operations are always explicit: use `crudOperations.all()`,
`crudOperations.readOnly()`, or `crudOperations.only(...)`. Omitting operations
is a resource-definition error.

List queries use these forms:

```text
filter[name][icontains]=ada
filter[id][in]=1,2,3
sort=-createdAt,name
search=engineer
include=posts,profile
deleted=include
page=2&limit=20
after=<signed-cursor>&limit=20
```

Filters, sort fields, search fields, includes, and deleted-row access are all
allowlisted. Cursor tokens are versioned and HMAC-SHA-256 signed, bind the
resource and exact ordering, and include every ID field as a stable tie-breaker.
Cursor sort fields must be non-nullable. A cursor-enabled resource fails at
bootstrap unless the root module has a secret of at least 32 bytes; load it from
validated application configuration through `forRootAsync()`. The deliberately
insecure codec is exported only from `@nestm/crud/testing`.

Pagination mode defaults are deliberate:

- no pagination configuration means offset mode;
- `{ cursor: true }` means cursor-only mode;
- set `{ offset: true, cursor: true }` to accept both; and
- set `{ offset: true, cursor: false }` for explicit offset-only mode.

Offset responses include total counts and page metadata. Cursor responses use
keyset pagination and contain only `limit`, `nextCursor`, and `hasNextPage`.

## Composite IDs

The ID contract must output one required property for every `itemPath` parameter
and `idFields` key. Composite IDs work throughout reads, mutations, relations,
and cursor tie-breaking:

```ts
const tenantUsers = defineCrudResource({
	fields: ["tenantId", "id"],
	name: "tenant-users",
	path: "tenant-users",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenantId", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string().uuid(), id: z.coerce.number().int().positive() }),
		create: CreateTenantUser,
		update: UpdateTenantUser,
		response: TenantUserResponse,
	},
	operations: crudOperations.all(),
});
```

The resource's `fields` tuple is the authoritative logical vocabulary. ORM
adapter column maps can translate those logical names to physical database columns.

## Nested resources

Collection paths may own part of a resource's identity. Declare those route
parameters separately for collection validation, while the ordinary ID contract
continues to describe the complete item route:

```ts
const versions = defineCrudResource({
	fields: ["artifactId", "versionId"],
	name: "artifact-versions",
	path: "artifacts/:artifactId/versions",
	pathParams: {
		contract: z.object({ artifactId: z.string().uuid() }),
		fields: { artifactId: "artifactId" },
	},
	itemPath: ":versionId",
	idFields: { artifactId: "artifactId", versionId: "versionId" },
	contracts: {
		id: z.object({ artifactId: z.string().uuid(), versionId: z.string().uuid() }),
		create: CreateVersion,
		update: UpdateVersion,
		response: VersionResponse,
	},
	operations: crudOperations.all(),
});
```

Nested list/count predicates always include the mapped parent values. Nested
creates treat those values as framework-owned insert values and therefore
require `mappings.scopeCreate` plus `scopeCreateFields`; request-body mappings
cannot override them. Scopes, hooks, adapter transaction runners, row
predicates, and after-commit events receive `context.pathParams`. Direct
headless calls use `crud.list(query, pathParams, context?)` and
`crud.create(input, pathParams, context?)`; item calls still receive the full
ID object.

Cursor tokens for a nested collection are bound to its parent values, so a
valid cursor issued under one parent is rejected under another. A nested
resource may be a relation source, but cannot be a relation target in this
release because a batched relation query has no single parent-path context.

## Custom controllers

For a fully custom controller, make the feature headless and inject the same
orchestrator into the application controller:

```ts
import { Controller, Get, Module, Query, type ExecutionContext } from "@nestjs/common";
import {
	createCrudPageSchema,
	CrudContext,
	CrudModule,
	type CrudRawQuery,
	CrudService,
	InjectCrud,
	resolveCrudPaginationModes,
} from "@nestm/crud";
import { StandardSchemaResponse } from "@nestm/standard-schema";

const UsersPage = createCrudPageSchema(
	users.contracts.response,
	resolveCrudPaginationModes(users.query?.pagination),
);

@Controller("admin/users")
export class AdminUsersController {
	constructor(@InjectCrud(users) private readonly crud: CrudService<typeof users>) {}

	@Get()
	@StandardSchemaResponse(UsersPage)
	list(@Query() query: CrudRawQuery, @CrudContext() context: ExecutionContext) {
		return this.crud.list(query, context);
	}
}

@Module({
	imports: [
		CrudModule.forFeature({
			resources: [usersBinding],
			generateControllers: false,
		}),
	],
	controllers: [AdminUsersController],
})
export class AdminUsersModule {}
```

`generateControllers` defaults to `true`. Setting it to `false` suppresses
controller generation for every resource in that `forFeature()` call, while
keeping binding and adapter providers, registry entries, service exports, and
resource imports available. This is intended for fully custom compatibility
controllers. To replace only selected operations, leave generation enabled,
omit those operations from the resource, and add custom routes alongside the
generated controller. `operations` controls generated route exposure; it is not
a runtime authorization boundary on direct `CrudService` calls. A custom route
must still declare an operation when its adapter capability or binding
configuration (for example atomic upsert) is validated from that declaration.

`CrudService` is where scopes, hooks, transactions, soft deletion, error
sanitization, and response mapping run, so custom controllers reuse the same
security-sensitive path. Generated-controller serialization metadata is not
inherited by a custom controller: apply `StandardSchemaResponse` (or Nest's
equivalent `@SerializeOptions({ schema })`) to every custom response. Likewise,
custom request parameters need explicit Standard Schema metadata when they are
not plain `@Query()` objects. Custom controllers also own their route, status,
authorization, validation, serialization, and OpenAPI decorators.

## Soft deletion

Configure a logical deletion field and explicitly add `restore`; it is not part
of `crudOperations.all()` unless supplied as an override:

```ts
operations: crudOperations.all({
	restore: { guards: [RestoreGuard] },
}),
softDelete: {
	field: "deletedAt",
	allowQueryDeleted: true,
	deleteValue: () => new Date(),
	restoreValue: () => null,
	queryDeletedEnhancers: { guards: [DeletedRowsGuard] },
},
```

Normal reads exclude deleted records. `deleted=include|only` is accepted only
when `allowQueryDeleted` is true. `queryDeletedEnhancers` decorate the generated
list route, so guards must inspect the request and require elevated access only
when `deleted` is `include` or `only`; ordinary list requests must still pass.
Soft-delete and explicit scope `updateValues` flow through
`mappings.persistence`, allowing logical fields to map safely to different
persistence keys.

## Scopes and hooks

Resource scopes are ordered injectable providers. Their predicates apply to
list/count/read/update/upsert/delete/restore and relation queries. Scope `createValues`
overwrite client values only while inserting, which supports tenant and owner
isolation without making immutable ownership updateable. A scope that
intentionally owns an update field must return it through distinct
`updateValues`.

Mutation hooks run in this order:

1. Resolve scopes and transactionally capture prior state where applicable.
2. Run `before*` hooks.
3. Perform the mutation.
4. Run `after*` hooks in the same transaction.
5. Commit.
6. Run `afterCommit`; report delivery failures to the configured sink without
   representing the committed mutation as rolled back.

Register scope and hook provider tokens on the resource and make those providers
available through the feature module's imports. A hook failure before commit
rolls back the mutation; an `afterCommit` failure is sent to
`afterCommitErrorHandler` after the committed response has been determined.
An adapter transaction must resolve only after the real commit it owns; a
savepoint or joined ambient transaction cannot satisfy this mutation contract.

## Atomic upsert

Upsert is an explicit opt-in operation; `crudOperations.all()` does not enable
it. Add an `upsert` request contract and select the operation to generate
`PUT itemPath`, or keep the resource headless and call `CrudService.upsert()`
from a compatibility controller:

```ts
const viewerBindings = defineCrudResource({
	// ...path, complete ID, and ordinary contracts
	fields: ["artifactId", "viewerUserId", "mcpServerId", "toolPrefix", "allowedTools"],
	contracts: { id, create, update, upsert: UpsertViewerBinding, response },
	operations: crudOperations.only("upsert", "delete"),
});

const binding = bindTypeOrmCrud({
	resource: viewerBindings,
	adapter,
	scopeCreateFields: ["viewerUserId"],
	upsert: {
		conflictFields: ["artifactId", "viewerUserId", "mcpServerId"],
		overwriteFields: ["toolPrefix", "allowedTools"],
	},
	mappings: {
		upsert: (id, input) => ({ ...id, ...input }),
		scopeCreate: (values) => ({ viewerUserId: values.viewerUserId }),
		// ...ordinary mappings
	},
});
```

The mapper produces one proposed final insert row; scope-owned values are
merged last. `conflictFields` and `overwriteFields` are adapter persistence
paths, not public field names. The conflict target may include scope-owned
identity columns that are absent from the URL, while overwrite fields must be
disjoint from both the conflict identity and `scopeCreateFields`.

An adapter advertising the optional atomic-upsert capability must perform one
race-free statement, apply the normal resource and scope predicate inside the
conflict-update arm, return `null` for a hidden conflict without changing it,
and return the resulting record without a reload. Upsert has dedicated
`beforeUpsert`/`afterUpsert`/`afterCommit` lifecycle events and deliberately has
no pre-read, `prior` record, or created-versus-updated branch signal. The
TypeORM PostgreSQL adapter is certified for this contract; the other bundled
adapters currently reject resources that enable upsert.

## Projections

Some response fields are not columns. An adapter selects from one table with no
join and no `groupBy`, so an aggregate — `artifactCount` on a project,
`memberCount` on an organization — is invisible to it by design.

A projection resolves those fields for a whole page at once:

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
	fields: ["id"],
	projections: [ProjectArtifactCounts],
});
```

`project` receives the entire page and returns one entry per record, aligned by
index; returning a different number of entries is an error rather than a silent
truncation. Several projections merge in declaration order, so a later one wins
a key collision. The merged result reaches the binding as the optional third
argument of `mappings.response(record, relations, projected?)` — `undefined`
when the resource declares none.

Batching is the point. A per-record resolver would issue one aggregate query per
row, so projections run once per page on `list`, once per relation target set
when an include is expanded, and once for the single record on `read` and on the
create/update/restore responses. Mutation responses are projected too, so one
response schema does not yield two shapes depending on the verb.

Register projection tokens on the resource and make the providers available
through the feature module's imports, exactly as for scopes and hooks.

Generated routes can also carry integration-specific Nest metadata without a
CRUD dependency on that integration:

```ts
enhancers: { decorators: [ApiTenant()] },
operations: crudOperations.all({
	list: { decorators: [RequirePermission("document:list")] },
	read: { decorators: [RequirePermission("document:read")] },
}),
```

Resource decorators are applied to the generated controller. Operation and
`queryDeletedEnhancers` decorators are applied to their generated handlers.
Decorator arrays are copied and frozen when the resource is defined.

## Relations

`belongsTo`, `hasOne`, and `hasMany` relations are one-hop, opt-in includes:

```ts
relations: {
	posts: defineCrudRelation({
		type: "hasMany",
		target: () => posts,
		local: ["id"],
		foreign: ["authorId"],
		maxItems: 50,
	}),
},
```

Register both resource bindings. `include=posts` batches the target query,
supports composite join tuples, and always applies the target resource's scopes
and soft-delete policy. To-many includes fetch one row beyond `maxItems` (or the
root `maxRelatedRows`) and return `422` if the bound is exceeded; data is never
silently truncated. Nested relation traversal is deferred.

## Errors

Generated routes preserve Nest's normal exception body shape. Invalid request,
query, cursor, or database-constraint input returns `400`; missing and
scope-hidden records return `404`; unique conflicts return `409`; over-bound
relations return `422`. Unexpected adapter and transactional-hook failures
return a sanitized `500`; raw ORM errors are never sent to the client.
Mapped conflict and constraint exceptions retain the originating
`CrudAdapterError` as their internal `cause`, allowing custom facades and logs
to distinguish retryable conflicts without exposing persistence details on the
wire.

## Adapter authors

Import the stable SPI from `@nestm/crud/adapter`. An adapter compiles the neutral
predicate/order AST into parameterized database APIs and implements transaction,
create, find-one, find-page/count, update, and delete. Bindings must map API
create/update values to persistence fields and persistence records to response
DTO inputs; ORM entities never escape automatically.

`CrudAdapterError.retryable` distinguishes conflicts for which the complete
operation may be retried in a fresh transaction. CRUD never retries operations
itself because doing so could repeat lifecycle-hook side effects. Use
`isCrudAdapterError()` instead of `instanceof` at package boundaries so errors
remain recognizable when a package manager installs more than one CRUD copy.

Application binders are `bindMemoryCrud`, `bindTypeOrmCrud`,
`bindDrizzleCrud`, and `bindPrismaCrud`. Each accepts standard Nest `useValue`,
`useClass`, `useExisting`, or `useFactory` adapter providers. The SQL binders
never create, initialize, connect, disconnect, or destroy consumer-owned
repositories and clients. In the first alpha, TypeORM 1.1.x, Drizzle 0.45.x,
and Prisma 7.10.x are certified against PostgreSQL only.

The TypeORM adapter also accepts a native `select` object for resources backed
by entities with sensitive or operational columns. Selected mode narrows both
the database hydration and the binding's record type, and its direct DML path
uses only an explicit `RETURNING` allowlist so TypeORM cannot perform a hidden
full-row reload during mutations. All primary columns must be selected. Entity
constructors and load listeners can still add runtime properties; see the
package README for the query-builder lifecycle tradeoffs.

Every binding supplies `create` and `update` mappings for API values and a
`response` mapping from a record plus loaded relations into the response-schema
input. Optional Standard Schema properties may be returned as explicit
`undefined`; CRUD removes those properties before passing mapped values to an
adapter. Define `persistence` when scopes or soft deletion generate logical
update values. It may be omitted when those values are always empty; a non-empty
unmapped value fails closed instead of being silently discarded. Soft-delete
bindings require the mapping during service construction. Scoped bindings
should additionally define `scopeCreate` to map their logical create values to
adapter insert fields.

When a scope owns required insert columns such as `tenantId` or `ownerId`, set
`scopeCreateFields: ["tenantId", "ownerId"]`. Only those declared fields become
optional in the contextual return type of `mappings.create`; an unscoped binding
still has to return its complete adapter create model. On create, the declared
fields must be materialized by `mappings.scopeCreate`, and those scope-derived
values overwrite any values returned by the API mapper.

For compatibility, a scoped binding without `scopeCreate` falls back to
`persistence`. That legacy path cannot model immutable insert-only fields and is
deprecated for removal in the next major version.

Reusable, runner-neutral conformance cases are available from
`@nestm/crud/testing` as `createCrudAdapterConformanceCases` and
`runCrudAdapterConformance`. That test-only subpath also exports
`InsecureCrudCursorCodec`; never use it in an application.

## Alpha scope

The first alpha includes base CRUD, structured filters, search, offset and
cursor pagination, composite IDs, soft delete/restore, one-hop bounded relation
includes, scopes, transactional lifecycle hooks, Standard Schema validation,
Swagger metadata, and four adapters. The broader
[hono-crud feature surface](https://github.com/kshdotdev/hono-crud/blob/80de807d7c18691b7ddedf6ccca6db47b5cb1b57/README.md#features)
is a staged roadmap, not an alpha release gate.

Batch operations, bulk patch, optimistic concurrency,
aggregates, full-text search, sparse fieldsets, import/export, computed fields,
audit history, record versioning, GraphQL, microservices, and schematics are
deferred. Cache, rate limiting, idempotency, logging/events/webhooks,
observability, encryption, approvals, health checks, and MCP remain separate
Nest-native integrations or future add-ons.

## Development

```sh
pnpm install
pnpm run check
pnpm run test
pnpm run verify:pack
```

The repository is BSD-3-Clause licensed.
