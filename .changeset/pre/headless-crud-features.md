---
"@nestm/crud": minor
---

Add a `generateControllers: false` option to `CrudModule.forFeature()` for
headless feature registrations. Headless features still register bindings,
adapters, services, relations, scopes, hooks, projections, and registry entries,
and they continue to export each resource's `CrudService` token for injection by
fully custom compatibility controllers.

The option defaults to `true`, preserving generated controllers and their route
collision validation for existing feature registrations.

HTTP exceptions mapped from adapter conflicts and constraints now retain the
original `CrudAdapterError` as their `cause`, so compatibility facades can
distinguish retryable transaction conflicts from domain conflicts without
parsing response messages.
