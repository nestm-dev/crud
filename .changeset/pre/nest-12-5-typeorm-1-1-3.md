---
"@nestm/crud": patch
"@nestm/crud-memory": patch
"@nestm/crud-typeorm": patch
"@nestm/crud-drizzle": patch
"@nestm/crud-prisma": patch
---

Drop the unused `@nestm/standard-schema` peer from `@nestm/crud`; Nest 12's native
`StandardSchemaValidationPipe` and serializer are enough. Test against NestJS 12.5, Swagger 12.1,
TypeORM 1.1.3, and PostgreSQL 18, with a pnpm catalog keeping every workspace importer on one
`@nestjs/core`/`typeorm` instance (the cause of the Nest ≥ 12.0.3 `Reflector` resolution failure
and the TypeORM duplicate-instance typecheck errors).
