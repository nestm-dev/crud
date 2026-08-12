import { describe, expect, it } from "vitest";

import { defineCrudFact, provideCrudFact, resolveCrudFacts } from "../src/runtime/crud-facts.ts";

describe("CRUD transaction facts", () => {
	it("keeps heterogeneous typed values behind a frozen read-only view", () => {
		const nameFact = defineCrudFact<string>("name");
		const countFact = defineCrudFact<number>("count");
		const facts = resolveCrudFacts([
			provideCrudFact(nameFact, "nested"),
			provideCrudFact(countFact, 2),
		]);

		expect(Object.isFrozen(facts)).toBe(true);
		expect(facts.has(nameFact)).toBe(true);
		expect(facts.get(nameFact)).toBe("nested");
		expect(facts.require(countFact)).toBe(2);
	});

	it("fails closed for missing and duplicate fact identities", () => {
		const fact = defineCrudFact<string>("authorization");
		const facts = resolveCrudFacts([]);

		expect(() => facts.require(fact)).toThrowError(/was not provided/u);
		expect(() =>
			resolveCrudFacts([provideCrudFact(fact, "first"), provideCrudFact(fact, "second")]),
		).toThrowError(/more than once/u);
	});

	it("rejects empty diagnostic names and snapshots fact entries", () => {
		expect(() => defineCrudFact<string>(" ")).toThrowError(/cannot be empty/u);
		const fact = defineCrudFact<{ readonly id: string }>("parent");
		const value = { id: "parent-1" };
		const entry = provideCrudFact(fact, value);

		expect(Object.isFrozen(fact)).toBe(true);
		expect(Object.isFrozen(entry)).toBe(true);
		expect(resolveCrudFacts([entry]).require(fact)).toBe(value);
	});
});
