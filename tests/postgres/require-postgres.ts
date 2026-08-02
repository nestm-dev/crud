import { beforeAll } from "vitest";

/**
 * PostgreSQL tests are intentionally opt-in and never silently skip because a database URL was
 * forgotten. Set PG_SKIP=1 for jobs that deliberately omit PostgreSQL, or provide PG_URL.
 */
beforeAll(() => {
	if (process.env.PG_SKIP === "1") return;
	if (process.env.PG_URL === undefined || process.env.PG_URL.length === 0) {
		throw new Error(
			"PostgreSQL conformance requires PG_URL. Start `docker compose up -d postgres` and set " +
				"PG_URL=postgresql://nestm:nestm@localhost:55435/nestm_crud, or explicitly set PG_SKIP=1.",
		);
	}
});
