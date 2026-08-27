---
"@nestm/crud": minor
"@nestm/crud-typeorm": minor
---

Add ordered, transaction-bound CRUD mutation validators with operation-specific
input, identity, session, and typed scope-fact contexts. Validators
run after before-hook input transformations and after source visibility checks,
while failures roll back and preserve application HTTP exceptions.

Add opaque typed scope facts for carrying an authorized parent or other derived
state through later mutation phases without exposing a mutable map or leaking
transaction-local state into after-commit events.

Add TypeORM reference checks that reuse the source CRUD mutation's active
transaction, apply a caller-provided identity-and-visibility predicate, and issue
a raw `SELECT 1 ... FOR SHARE` without hydrating the referenced entity or starting
a nested transaction.
