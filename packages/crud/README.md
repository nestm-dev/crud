# `@nestm/crud`

NestJS 12 CRUD resources, generated controllers, orchestration, query AST,
scopes, lifecycle hooks, Standard Schema response contracts, Swagger metadata,
and the adapter-author SPI.

See the [complete documentation](https://github.com/nestm-dev/crud#readme) for
installation, a full resource example, HTTP/query contracts, custom-controller
injection, and adapter guidance.

> [!CAUTION]
> This is a `0.1` alpha for the NestJS 12 prerelease line. SQL adapters are
> certified for PostgreSQL only.

## Required application wiring

Import `StandardSchemaModule.forRoot()` exactly once at the application root.
CRUD bootstrap fails if its global request validator or response serializer is
disabled or absent. `@nestm/standard-schema` and `@nestjs/swagger` are required
peers; CRUD itself never installs application guards, filters, or other global
policy.

Generated controllers include Swagger request, response, status, tag,
operation-ID, parameter, query, and Nest error metadata. If a schema vendor
depends on a custom Swagger `standardSchemaConverter`, wrap that converter with
`withCrudStandardSchemaConverter()` so list response envelopes are described.

`CrudModule.forRoot()` and `forRootAsync()` provide global runtime defaults.
`CrudModule.forFeature({ imports, resources })` synchronously registers feature
providers and, by default, deterministic ordinary Nest controllers before
bootstrap; adapter factories may still resolve asynchronously. Pass
`generateControllers: false` to keep the feature's bindings, registry entries,
service providers, imports, and service exports while generating no controllers.

## Contract notes

- `operations` is mandatory. Use `crudOperations.all()`, `readOnly()`, or
  `only(...)`; explicitly add `restore` when soft deletion is configured.
- The ID schema must output a required object whose keys exactly match the full
  `path + itemPath` parameters and `idFields`. Single, composite, and nested
  resource IDs are supported. Nested collection parameters use `pathParams`.
- With no pagination config, list uses offset mode. `{ cursor: true }` is
  cursor-only; set `{ offset: true, cursor: true }` to enable both.
- Cursor sort fields must be non-nullable. All ID fields are appended as stable
  tie-breakers, and cursor resources require an HMAC secret of at least 32 bytes.
- Soft-deleted rows are excluded normally. `deleted=include|only` requires
  `allowQueryDeleted`; `queryDeletedEnhancers` run on every generated list
  request, so their guards must gate only queries that actually request deleted
  rows.
- One-hop `belongsTo`, `hasOne`, and `hasMany` includes are batched and always
  apply the target scope and soft-delete policy. An over-bound to-many include
  returns `422` instead of truncating.
- Ordered scopes constrain list/count/read/mutations/restore/relations. Scope
  `createValues` apply only to inserts; a scope must opt into update overwrites
  with distinct `updateValues`. Before/after mutation hooks run in the
  transaction; `afterCommit` failures go to the configured error sink.
- Binding `scopeCreateFields` declares adapter insert fields supplied by scopes
  or nested paths through `mappings.scopeCreate`. Only declared fields may be omitted by
  `mappings.create`; missing declared values fail closed before adapter create.
- `enhancers.decorators` carries opaque Nest class decorators at resource level
  and method decorators at operation or `queryDeletedEnhancers` level. This lets
  integrations attach authorization metadata without coupling CRUD to them.
- Atomic upsert is opt-in and requires a capable adapter plus explicit
  persistence `conflictFields` and `overwriteFields`. It performs no pre-read;
  TypeORM/PostgreSQL is the currently certified bundled implementation.

Invalid inputs, queries, and cursors map to `400`, scope-hidden and absent rows
to `404`, unique conflicts to `409`, over-bound includes to `422`, and sanitized
unexpected adapter or transactional-hook failures to `500`. Mapped conflict
and constraint exceptions retain their `CrudAdapterError` as the internal
`cause`, so custom facades can distinguish retryable conflicts without parsing
or exposing persistence messages.

Adapter `transaction()` implementations must resolve only after the transaction
they own has really committed. A savepoint or joined ambient transaction cannot
satisfy this contract for mutations because CRUD runs `afterCommit` immediately
after `transaction()` resolves. `isCrudAdapterError()` is the cross-package-copy
error discriminator for adapter and integration authors.

For a fully custom compatibility controller, register the binding with
`CrudModule.forFeature({ resources: [binding], generateControllers: false })`
and inject its exported `CrudService` with `@InjectCrud(resource)`.
`generateControllers` defaults to `true` and the opt-out applies to every
resource in that feature call. The custom controller reuses CRUD orchestration
but not the generated controller's route, status, authorization, validation,
serialization, or OpenAPI decorators. Apply
`StandardSchemaResponse(createCrudPageSchema(...))` (or Nest
`@SerializeOptions({ schema })`) to serialize custom list responses, and apply
the resource response schema to custom single-item responses.

Public subpaths:

- `@nestm/crud` — application API.
- `@nestm/crud/adapter` — stable persistence-adapter SPI.
- `@nestm/crud/testing` — adapter conformance cases and the explicitly insecure
  test-only cursor codec.

This package is ESM-only, requires Node.js 22.12 or newer, and targets the
NestJS 12 prerelease line. `createCrudAdapterConformanceCases` and
`runCrudAdapterConformance` help adapter authors certify the shared contract;
`InsecureCrudCursorCodec` must never be used outside tests.

The alpha intentionally defers batch/bulk writes, optimistic
concurrency, aggregates/full-text search, sparse fieldsets, import/export,
audit/version history, GraphQL, microservices, and schematics. The broader
[hono-crud feature set](https://github.com/kshdotdev/hono-crud/blob/80de807d7c18691b7ddedf6ccca6db47b5cb1b57/README.md#features)
is a staged roadmap.
