---
"@nestm/crud": patch
"@nestm/crud-memory": patch
"@nestm/crud-typeorm": patch
"@nestm/crud-drizzle": patch
"@nestm/crud-prisma": patch
---

Add first-class optimistic concurrency with `concurrency: { field: "version" }`. Responses carry
`ETag`; PATCH, PUT, and DELETE require `If-Match` (absent → 428, stale → 412) and compare it with
the row read under a write lock, then pin the UPDATE/DELETE to that version so a lost race also
answers 412. Conditional PUT accepts `If-None-Match: *` for create-only. Adapters receive an
advisory `lock` on `findOne` (implemented by TypeORM), the conformance kit gains a
version-guard case, and Swagger documents the headers and the 412/428 responses.
