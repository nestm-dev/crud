import type { CrudPredicate } from "@nestm/crud/adapter";
import { describe, expect, it } from "vitest";

import { compilePrismaOrder, compilePrismaPredicate } from "../src/prisma-predicate.ts";

describe("compilePrismaPredicate", () => {
	it("compiles nested filters and case-insensitive contains", () => {
		const predicate: CrudPredicate = {
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "age", operator: "between", value: [18, 65] },
				{ kind: "comparison", field: "name", operator: "icontains", value: "ana" },
			],
		};

		expect(compilePrismaPredicate(predicate, { name: "displayName" })).toEqual({
			AND: [
				{ age: { gte: 18, lte: 65 } },
				{ displayName: { contains: "ana", mode: "insensitive" } },
			],
		});
	});

	it("compiles mixed ordering using mapped fields", () => {
		expect(
			compilePrismaOrder(
				[
					{ field: "createdAt", direction: "desc" },
					{ field: "id", direction: "asc" },
				],
				{ createdAt: "created_at" },
			),
		).toEqual([{ created_at: "desc" }, { id: "asc" }]);
	});

	it("compiles isnull on required fields to Prisma boolean identities", () => {
		const required = new Set(["name"]);

		expect(
			compilePrismaPredicate(
				{ kind: "comparison", field: "name", operator: "isnull", value: true },
				{},
				required,
			),
		).toEqual({ OR: [] });
		expect(
			compilePrismaPredicate(
				{ kind: "comparison", field: "name", operator: "isnull", value: false },
				{},
				required,
			),
		).toEqual({ AND: [] });
	});
});
