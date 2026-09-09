import {
	compileTypeOrmFullTextSearch,
	compileTypeOrmFullTextVector,
	createTypeOrmCrudAdapter,
} from "@nestm/crud-typeorm";
import type { CrudFullTextSearchInput } from "@nestm/crud/adapter";
import { Brackets, Column, DataSource, Entity, PrimaryColumn } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TABLE = "crud_pg_full_text_items";
@Entity({ name: TABLE, synchronize: false })
class SearchItem {
	@PrimaryColumn({ type: "text" }) id!: string;
	@Column({ type: "text" }) tenant!: string;
	@Column({ type: "text" }) title!: string;
	@Column({ type: "text", nullable: true }) description!: string | null;
	@Column({ type: "text" }) status!: string;
}
const fields = ["title", "description"] as const;
const policy = {
	configuration: "simple",
	queryMode: "prefix",
	primaryField: "title",
	weights: { title: "A", description: "D" },
} as const;
const context = { resource: "search-items", operation: "list" } as const;
let source: DataSource;
function adapter() {
	return createTypeOrmCrudAdapter({
		repository: source.getRepository(SearchItem),
		columns: { id: true, tenant: true, title: true, description: true, status: true },
		rowPredicate: ({ alias }) =>
			new Brackets((builder) =>
				builder.where(`${alias}.tenant = :visible_tenant`, { visible_tenant: "one" }),
			),
	});
}
function find(
	query: string,
	changes: Partial<CrudFullTextSearchInput<"title" | "description">> = {},
	offset = 0,
	limit = 20,
) {
	return adapter().findMany(
		{
			fullText: { fields, ...policy, query, ...changes },
			predicate: { kind: "comparison", field: "status", operator: "eq", value: "active" },
			order: [{ field: "id", direction: "asc" }],
			offset,
			limit,
			count: true,
		},
		context,
	);
}

describe.skipIf(process.env.PG_SKIP === "1")("PostgreSQL full-text CRUD search", () => {
	beforeAll(async () => {
		const url = process.env.PG_URL;
		if (url === undefined) throw new Error("PG_URL is required.");
		source = await new DataSource({
			type: "postgres",
			url,
			entities: [SearchItem],
			synchronize: false,
		}).initialize();
		await source.query(
			`CREATE TABLE ${TABLE} (id text PRIMARY KEY, tenant text NOT NULL, title text NOT NULL, description text, status text NOT NULL)`,
		);
		const vector = compileTypeOrmFullTextVector(fields, policy, (field) => `"${field}"`);
		await source.query(`CREATE INDEX crud_pg_full_text_gin ON ${TABLE} USING GIN ((${vector}))`);
		await source.getRepository(SearchItem).insert([
			{
				id: "weight-title",
				tenant: "one",
				title: "Zebra guide",
				description: null,
				status: "active",
			},
			{
				id: "weight-description",
				tenant: "one",
				title: "Field guide",
				description: "Zebra guide",
				status: "active",
			},
			{
				id: "exact",
				tenant: "one",
				title: "Quarterly report",
				description: null,
				status: "active",
			},
			{
				id: "prefix",
				tenant: "one",
				title: "Quarterly reporting budget",
				description: null,
				status: "active",
			},
			{
				id: "words",
				tenant: "one",
				title: "Budget report for quarterly revenue",
				description: null,
				status: "active",
			},
			{
				id: "description",
				tenant: "one",
				title: "Annual summary",
				description: "Quarterly report ".repeat(30),
				status: "active",
			},
			{
				id: "other-tenant",
				tenant: "two",
				title: "Quarterly report",
				description: null,
				status: "active",
			},
			{
				id: "archived",
				tenant: "one",
				title: "Quarterly report",
				description: null,
				status: "archived",
			},
			{
				id: "stemming",
				tenant: "one",
				title: "Running foxes",
				description: null,
				status: "active",
			},
			{
				id: "punctuation",
				tenant: "one",
				title: "D'Artagnan's notes",
				description: null,
				status: "active",
			},
		]);
	});
	afterAll(async () => {
		if (source?.isInitialized) {
			await source.query(`DROP TABLE IF EXISTS ${TABLE}`);
			await source.destroy();
		}
	});
	it("ranks names before descriptions, applies visibility and filters to counts, then paginates", async () => {
		const first = await find("Quarterly report", {}, 0, 2);
		expect(first.records.map(({ id }) => id)).toEqual(["exact", "prefix"]);
		expect(first.total).toBe(4);
		const second = await find("Quarterly report", {}, 2, 2);
		expect(second.records.map(({ id }) => id)).toEqual(["words", "description"]);
		expect(second.total).toBe(4);
	});
	it("normalizes case and token order and supports partial words", async () => {
		const result = await find("ReP QuArT");
		expect(result.records.map(({ id }) => id).toSorted()).toEqual([
			"description",
			"exact",
			"prefix",
			"words",
		]);
		expect(result.total).toBe(4);
	});
	it("uses configured stemming and web-search phrases/exclusions", async () => {
		expect(
			(await find("run fox", { configuration: "english", queryMode: "plain" })).records.map(
				({ id }) => id,
			),
		).toEqual(["stemming"]);
		expect(
			(await find('"quarterly report" -budget', { queryMode: "websearch" })).records.map(
				({ id }) => id,
			),
		).toEqual(["exact", "description"]);
	});
	it("weights title matches even without explicit primary-field ordering", async () => {
		const result = await adapter().findMany(
			{
				fullText: { fields, query: "zebra", weights: { title: "A", description: "D" } },
				predicate: {
					kind: "comparison",
					field: "id",
					operator: "in",
					value: ["weight-title", "weight-description"],
				},
				order: [{ field: "id", direction: "asc" }],
				limit: 2,
				count: true,
			},
			context,
		);
		expect(result.total).toBe(2);
		expect(result.records.map(({ id }) => id)).toEqual(["weight-title", "weight-description"]);
	});
	it.each(["%_", "   ", "' OR 1=1 --", "missing"])(
		"does not broaden empty or literal input: %s",
		async (query) => {
			expect(await find(query)).toEqual({ records: [], total: 0 });
		},
	);
	it("quotes normalized lexemes safely in prefix mode", async () => {
		expect((await find("D'Artagnan")).records.map(({ id }) => id)).toEqual(["punctuation"]);
	});
	it("uses the same indexed expression in custom repository queries", async () => {
		const search = compileTypeOrmFullTextSearch(
			{ fields, ...policy, query: "quarterly" },
			(field) => `item.${field}`,
		);
		const runner = source.createQueryRunner();
		await runner.startTransaction();
		try {
			await runner.query("SET LOCAL enable_seqscan = off");
			const query = runner.manager
				.getRepository(SearchItem)
				.createQueryBuilder("item")
				.where(search.sql, search.parameters);
			const [sql, parameters] = query.getQueryAndParameters();
			const plan: unknown = await runner.query(`EXPLAIN (FORMAT JSON) ${sql}`, parameters);
			expect(JSON.stringify(plan)).toContain("crud_pg_full_text_gin");
		} finally {
			await runner.rollbackTransaction();
			await runner.release();
		}
	});
	it("rejects native predicates that collide with search parameters", async () => {
		const unsafe = createTypeOrmCrudAdapter({
			repository: source.getRepository(SearchItem),
			columns: { id: true, title: true },
			rowPredicate: ({ alias }) =>
				new Brackets((builder) =>
					builder.where(`${alias}.id = :crud_search_query`, { crud_search_query: "other-tenant" }),
				),
		});
		await expect(
			unsafe.findMany(
				{ fullText: { fields: ["title"], query: "quarterly" }, order: [], limit: 10, count: true },
				context,
			),
		).rejects.toMatchObject({ code: "unsupported" });
	});
});
