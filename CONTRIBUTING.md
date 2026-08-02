# Contributing

This project is an experimental NestJS 12 alpha. Please discuss substantial API
or adapter-SPI changes before implementing them, because all five packages are
released in lockstep.

## Local checks

Use Node.js 22.12 or newer and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm run check
pnpm run test
pnpm run verify:pack
```

Changes to an adapter must run the shared conformance cases. Claims about a
database or dialect require a real-database integration test; mocked query
builders are useful unit tests but are not certification.

Add a Changeset for user-visible changes:

```sh
pnpm changeset
```

Keep public APIs strictly typed and ESM-only. Do not expose ORM records from the
core service, accept unvalidated field names, interpolate query values into SQL,
or make a package own a consumer's database connection lifecycle.
