import type { CrudPredicate } from "@nestm/crud/adapter";
import { integer, pgTable, text, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { compileDrizzlePredicate } from "../src/drizzle-predicate.ts";

const users = pgTable("users", {
	id: integer().primaryKey(),
	name: text().notNull(),
});

describe("compileDrizzlePredicate", () => {
	it("uses placeholders for values and quoted configured columns", () => {
		const predicate: CrudPredicate = {
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "id", operator: "gte", value: 10 },
				{ kind: "comparison", field: "name", operator: "icontains", value: "a%" },
			],
		};
		const compiled = compileDrizzlePredicate(predicate, { id: users.id, name: users.name });
		const query = new PgDialect().sqlToQuery(compiled);

		expect(query.sql).toContain('"users"."id" >= $1');
		expect(query.sql).toContain('"users"."name" ilike $2');
		expect(query.params).toEqual([10, "%a\\%%"]);
	});

	it("rejects unmapped fields", () => {
		expect(() =>
			compileDrizzlePredicate(
				{ kind: "comparison", field: "email", operator: "eq", value: "x" },
				{ id: users.id },
			),
		).toThrow("does not map");
	});
});
