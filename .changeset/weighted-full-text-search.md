---
"@nestm/crud": patch
"@nestm/crud-typeorm": patch
"@nestm/crud-memory": patch
"@nestm/crud-drizzle": patch
"@nestm/crud-prisma": patch
---

Add opt-in PostgreSQL full-text search with weighted fields, primary-field ranking,
plain/websearch/prefix query modes, and offset pagination. Export the TypeORM search
and vector compilers for custom repositories and consumer-owned GIN indexes. Reject
unsupported adapters and rank-ordered cursor queries instead of silently falling back.
