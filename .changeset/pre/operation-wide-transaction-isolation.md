---
"@nestm/crud-typeorm": minor
"@nestm/crud-drizzle": minor
---

Add an operation-wide transaction isolation requirement so scopes, lifecycle
hooks, validators, mappings, projections, and persistence start inside a
sufficiently strong transaction. This prevents snapshot-sensitive nested work
from attempting an unsafe mid-transaction isolation promotion, including during
create operations.
