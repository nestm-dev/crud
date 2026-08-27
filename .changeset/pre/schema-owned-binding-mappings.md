---
"@nestm/crud": minor
---

Allow binding mappers to return Standard Schema optional properties directly;
CRUD removes explicitly undefined optional values before invoking adapters.
Make `mappings.persistence` optional when the framework contributes no scope or
soft-delete update values, while failing closed for non-empty unmapped values.
