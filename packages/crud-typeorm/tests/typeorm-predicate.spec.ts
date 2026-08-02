import type { CrudPredicate } from "@nestm/crud/adapter";
import { describe, expect, it } from "vitest";

import { compileTypeOrmPredicate } from "../src/typeorm-predicate.ts";

describe("compileTypeOrmPredicate", () => {
	it("compiles nested predicates with named parameters", () => {
		const predicate: CrudPredicate = {
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "age", operator: "gte", value: 18 },
				{
					kind: "or",
					predicates: [
						{ kind: "comparison", field: "name", operator: "icontains", value: "a%_\\" },
						{ kind: "comparison", field: "id", operator: "in", value: [1, 2] },
					],
				},
			],
		};

		const result = compileTypeOrmPredicate(predicate, (field) => `record.${field}`);

		expect(result.sql).toBe(
			"(record.age >= :crud_0 AND (record.name ILIKE :crud_1 ESCAPE '\\' OR record.id IN (:...crud_2)))",
		);
		expect(result.parameters).toEqual({ crud_0: 18, crud_1: "%a\\%\\_\\\\%", crud_2: [1, 2] });
	});

	it("emits constants for empty membership sets", () => {
		expect(
			compileTypeOrmPredicate(
				{ kind: "comparison", field: "id", operator: "in", value: [] },
				(field) => field,
			).sql,
		).toBe("1 = 0");
	});
});
