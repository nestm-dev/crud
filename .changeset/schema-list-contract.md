---
"@nestm/crud": patch
"@nestm/crud-memory": patch
"@nestm/crud-typeorm": patch
"@nestm/crud-drizzle": patch
"@nestm/crud-prisma": patch
---

Add a pluggable per-resource list contract. `query.schema` binds one Standard Schema for the
whole list query through Nest's `@Query({ schema })` (validated by Nest, documented by Swagger),
and `query.toListQuery(parsed)` maps it to a parser-independent `CrudListRequest` (predicate AST,
order, offset page or keyset cursor). `CrudService.listQuery()` runs such a request directly,
skipping every grammar. The bracket grammar stays the default whenever `query.schema` is absent.
Bracket resources can rename `page`/`limit`/`after` with `query.pagination.parameters`, and any
resource can replace the page `meta` with `query.pagination.meta` formatters whose schemas drive
response validation and OpenAPI.
