import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { resolveCrudModuleOptions } from "../src/module/crud-module.options.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { parseCrudListQuery } from "../src/query/query-parser.ts";
import type { CrudFullTextSearchOptions } from "../src/query/query.types.ts";
import { CrudService } from "../src/runtime/crud.service.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

function resource(fullText: CrudFullTextSearchOptions<"name"> = {}) {
	return defineCrudResource({
		name: "full-text-items",
		fields: ["id", "name", "tenant"],
		path: "items",
		itemPath: ":id",
		idFields: { id: "id" },
		contracts: {
			id: z.object({ id: z.number() }),
			create: z.object({ name: z.string() }),
			update: z.object({ name: z.string().optional() }),
			response: z.object({ id: z.number(), name: z.string() }),
		},
		operations: { list: {} },
		query: {
			filters: { name: { schema: z.string(), operators: ["eq"] } },
			sort: { fields: ["id"], default: ["id"], cursor: ["id"] },
			search: { fields: ["name"], fullText },
			pagination: { offset: true, cursor: true },
		},
	});
}
function service(adapter: FakeCrudAdapter) {
	const definition = resource({
		primaryField: "name",
		weights: { name: "A" },
		queryMode: "prefix",
	});
	const binding = defineCrudBinding({
		resource: definition,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) => input,
			update: (input) => input,
			response: (record) => ({ id: Number(record.id), name: String(record.name) }),
		},
	});
	// Cursor parsing is tested separately; this service uses the offset resource.
	const offset = defineCrudResource({
		...definition,
		query: { ...definition.query, pagination: { offset: true } },
	});
	return new CrudService(
		offset,
		{ ...binding, resource: offset },
		adapter,
		[],
		[
			{
				resolve: () => ({
					predicate: { kind: "comparison", field: "tenant", operator: "eq", value: "one" },
				}),
			},
		],
		new CrudRegistry(),
		resolveCrudModuleOptions({}),
	);
}

describe("full-text search orchestration", () => {
	it("passes full-text policy independently of scopes/filters inside the list transaction", async () => {
		const adapter = new FakeCrudAdapter([], { fullTextSearch: true, containsInsensitive: false });
		const find = vi.spyOn(adapter, "findMany");
		await service(adapter).list({
			search: "Ada",
			page: "2",
			limit: "5",
			"filter[name][eq]": "visible",
		});
		expect(find).toHaveBeenCalledWith(
			expect.objectContaining({
				fullText: {
					fields: ["name"],
					primaryField: "name",
					weights: { name: "A" },
					queryMode: "prefix",
					query: "Ada",
				},
				offset: 5,
				limit: 5,
				count: true,
				predicate: {
					kind: "and",
					predicates: [
						{ kind: "comparison", field: "name", operator: "eq", value: "visible" },
						{ kind: "comparison", field: "tenant", operator: "eq", value: "one" },
					],
				},
			}),
			expect.objectContaining({ session: expect.any(Object) }),
		);
	});
	it("fails closed when the adapter cannot perform full-text search", () => {
		expect(() => service(new FakeCrudAdapter())).toThrow(/lacks full-text search/u);
	});
	it("rejects rank-ordered cursor searches while allowing offset searches", async () => {
		await expect(
			parseCrudListQuery(resource(), { search: "Ada", after: "cursor" }),
		).rejects.toMatchObject({ code: "invalid_pagination" });
		await expect(
			parseCrudListQuery(resource(), { search: "Ada", page: "1" }),
		).resolves.toMatchObject({ mode: "offset", search: "Ada" });
	});
	it("snapshots and freezes weighted search policy", () => {
		const weights = { name: "A" as const };
		const definition = resource({ weights });
		Reflect.set(weights, "name", "D");
		expect(definition.query?.search?.fullText?.weights).toEqual({ name: "A" });
		expect(Object.isFrozen(definition.query?.search?.fullText)).toBe(true);
		expect(Object.isFrozen(definition.query?.search?.fullText?.weights)).toBe(true);
	});
	it.each([
		{ configuration: "simple'); DROP TABLE items; --" },
		{ primaryField: "tenant" },
		{ weights: { name: "wrong" } },
		{ weights: { tenant: "A" } },
		{ queryMode: "raw" },
	])("rejects invalid server-owned policy: %j", (options) => {
		expect(() => Reflect.apply(resource, undefined, [options])).toThrow(TypeError);
	});
});
