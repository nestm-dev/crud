# PostgreSQL conformance

The integration suite executes the shared adapter contract and differential predicate checks
against real TypeORM, Drizzle, and Prisma clients. It owns only tables prefixed with
`crud_pg_`, truncates them before every case, and drops them when the suite exits.

```sh
docker compose up -d --wait postgres
PG_URL=postgresql://nestm:nestm@localhost:55435/nestm_crud pnpm test:postgres
docker compose down
```

`test:postgres` deliberately fails when `PG_URL` is absent. A job that intentionally has no
PostgreSQL service must opt out with `PG_SKIP=1`; the suite never infers a skip from a failed
connection.
