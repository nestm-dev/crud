import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { resolveCrudModuleOptions } from "../src/module/crud-module.options.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import { CrudService } from "../src/runtime/crud.service.ts";
import type { CrudProjection } from "../src/runtime/runtime.types.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

/**
 * `commentCount` is the shape this feature exists for: an aggregate that no single-table select
 * can produce, so the adapter cannot see it and only a batch query can resolve it cheaply.
 */
const articleResource = defineCrudResource({
	fields: ["id", "title"],
	name: "articles",
	path: "articles",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ title: z.string() }),
		update: z.object({ title: z.string().optional() }),
		response: z.object({
			id: z.number().int(),
			title: z.string(),
			commentCount: z.number().int().optional(),
			badge: z.string().optional(),
		}),
	},
	operations: crudOperations.all(),
	query: { pagination: { offset: true } },
});

function articleBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: articleResource,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) => ({ title: input.title }),
			update: (input) => (input.title === undefined ? {} : { title: input.title }),
			persistence: (values) => values,
			response: (record, _relations, projected) => ({
				id: Number(record.id),
				title: String(record.title),
				...(typeof projected?.commentCount === "number"
					? { commentCount: projected.commentCount }
					: {}),
				...(typeof projected?.badge === "string" ? { badge: projected.badge } : {}),
			}),
		},
	});
}

function createArticleService(
	rows: readonly Record<string, unknown>[],
	projections: readonly CrudProjection<typeof articleResource>[] = [],
) {
	const adapter = new FakeCrudAdapter(rows);
	const binding = articleBinding(adapter);
	const service = new CrudService(
		articleResource,
		binding,
		adapter,
		[],
		[],
		new CrudRegistry(),
		resolveCrudModuleOptions({}),
		undefined,
		projections,
	);
	return { adapter, binding, service };
}

const ROWS = [
	{ id: 1, title: "First" },
	{ id: 2, title: "Second" },
	{ id: 3, title: "Third" },
];

/** Counts derived from the batch, so a projection that ignores `records` cannot fake it. */
function countingProjection(counts: Record<number, number>) {
	return {
		project: vi.fn((records: readonly unknown[]) =>
			records.map((record) => ({
				commentCount: counts[Number((record as { id: number }).id)] ?? 0,
			})),
		),
	};
}

describe("batch projections", () => {
	it("resolves the whole page in ONE call, not one per record", async () => {
		// This is the property the feature exists for. A per-record hook would make each of these
		// resources cost N aggregate queries per page, which is why they were not worth generating.
		const projection = countingProjection({ 1: 7, 2: 0, 3: 42 });
		const { service } = createArticleService(ROWS, [projection]);

		const page = await service.list({ page: "1", limit: "10" });

		expect(projection.project).toHaveBeenCalledTimes(1);
		expect(projection.project.mock.calls[0]?.[0]).toHaveLength(3);
		expect(page.data).toEqual([
			{ id: 1, title: "First", commentCount: 7 },
			{ id: 2, title: "Second", commentCount: 0 },
			{ id: 3, title: "Third", commentCount: 42 },
		]);
	});

	it("aligns values to records by index, not by insertion order", async () => {
		const projection = {
			project: (records: readonly unknown[]) =>
				records.map((_record, index) => ({ commentCount: index * 10 })),
		};
		const { service } = createArticleService(ROWS, [projection]);

		const page = await service.list({ page: "1", limit: "10" });

		expect(page.data.map((item) => item.commentCount)).toEqual([0, 10, 20]);
	});

	it("receives the operation context so a projection can scope itself", async () => {
		const seen: string[] = [];
		const projection: CrudProjection<typeof articleResource> = {
			project: (records, context) => {
				seen.push(context.operation);
				return records.map(() => ({ commentCount: 1 }));
			},
		};
		const { service } = createArticleService(ROWS, [projection]);

		await service.list({ page: "1", limit: "10" });
		await service.read({ id: 1 });

		expect(seen).toEqual(["list", "read"]);
	});

	it("merges several projections, last declaration winning a collision", async () => {
		const first: CrudProjection<typeof articleResource> = {
			project: (records) => records.map(() => ({ commentCount: 1, badge: "from-first" })),
		};
		const second: CrudProjection<typeof articleResource> = {
			project: (records) => records.map(() => ({ badge: "from-second" })),
		};
		const { service } = createArticleService(ROWS, [first, second]);

		const page = await service.list({ page: "1", limit: "10" });

		expect(page.data[0]).toEqual({ id: 1, title: "First", commentCount: 1, badge: "from-second" });
	});

	it("projects single-record reads too", async () => {
		const projection = countingProjection({ 2: 5 });
		const { service } = createArticleService(ROWS, [projection]);

		await expect(service.read({ id: 2 })).resolves.toEqual({
			id: 2,
			title: "Second",
			commentCount: 5,
		});
	});

	it("projects mutation responses, so POST and GET agree on the shape", async () => {
		// Without this, `create` would answer with a body missing `commentCount` while `read` of the
		// same row includes it — one response schema, two shapes, and only the write path wrong.
		const projection: CrudProjection<typeof articleResource> = {
			project: (records) => records.map(() => ({ commentCount: 0 })),
		};
		const { service } = createArticleService(ROWS, [projection]);

		await expect(service.create({ title: "Fourth" })).resolves.toMatchObject({ commentCount: 0 });
		await expect(service.update({ id: 1 }, { title: "Renamed" })).resolves.toMatchObject({
			commentCount: 0,
		});
	});

	it("passes `undefined` when the resource declares no projections", async () => {
		// Bindings written against the two-argument `response` must see exactly the old behaviour.
		// `defineCrudBinding` freezes its mappings, so the third argument is recorded from inside
		// the mapping rather than spied on.
		const thirdArguments: unknown[] = [];
		const adapter = new FakeCrudAdapter(ROWS);
		const binding = defineCrudBinding({
			resource: articleResource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => ({ title: input.title }),
				update: (input) => (input.title === undefined ? {} : { title: input.title }),
				persistence: (values) => values,
				response: (record, _relations, projected) => {
					thirdArguments.push(projected);
					return { id: Number(record.id), title: String(record.title) };
				},
			},
		});
		const service = new CrudService(
			articleResource,
			binding,
			adapter,
			[],
			[],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
		);

		const page = await service.list({ page: "1", limit: "10" });

		expect(thirdArguments).toEqual([undefined, undefined, undefined]);
		expect(page.data[0]).toEqual({ id: 1, title: "First" });
	});

	it("rejects a projection whose result does not cover the page", async () => {
		// Silently dropping the tail would mean rows that render without their aggregate — visible
		// only as a missing field in production, so it fails loudly instead.
		const projection: CrudProjection<typeof articleResource> = {
			project: () => [{ commentCount: 1 }],
		};
		const { service } = createArticleService(ROWS, [projection]);

		await expect(service.list({ page: "1", limit: "10" })).rejects.toMatchObject({
			status: 500,
			message: expect.stringContaining("returned 1 entries for 3 records"),
		});
	});

	it("does not call a projection for an empty page", async () => {
		const projection = countingProjection({});
		const { service } = createArticleService([], [projection]);

		await expect(service.list({ page: "1", limit: "10" })).resolves.toMatchObject({ data: [] });
		expect(projection.project).not.toHaveBeenCalled();
	});
});

/* ── relation targets ─────────────────────────────────────────────────────────────────────── */

const commentResource = defineCrudResource({
	fields: ["id", "articleId", "body"],
	name: "comments",
	path: "comments",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ articleId: z.number(), body: z.string() }),
		update: z.object({ body: z.string().optional() }),
		response: z.object({
			id: z.number().int(),
			articleId: z.number().int(),
			score: z.number().int().optional(),
		}),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
});

const articleWithComments = defineCrudResource({
	fields: ["id", "title"],
	name: "articles-with-comments",
	path: "articles-with-comments",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ title: z.string() }),
		update: z.object({ title: z.string().optional() }),
		response: z.object({ id: z.number().int(), comments: z.array(z.unknown()) }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
	relations: {
		comments: {
			type: "hasMany",
			target: () => commentResource,
			local: ["id"],
			foreign: ["articleId"],
			maxItems: 5,
		},
	},
});

describe("projections on relation targets", () => {
	it("projects included records in ONE batch for the whole page", async () => {
		// `loadRelation` already fetches every target for the page in a single query, so the
		// projection must piggyback on that batch rather than reintroduce the N+1 through the back
		// door. Two articles, three comments between them, one projection call.
		const project = vi.fn((records: readonly unknown[], context: { session?: unknown }) => {
			expect(context.session).toBeDefined();
			return records.map((record) => ({
				score: Number((record as { id: number }).id) * 100,
			}));
		});
		const scores: CrudProjection = { project };
		const registry = new CrudRegistry();
		const options = resolveCrudModuleOptions({});

		const commentAdapter = new FakeCrudAdapter([
			{ id: 10, articleId: 1, body: "a" },
			{ id: 11, articleId: 1, body: "b" },
			{ id: 12, articleId: 2, body: "c" },
		]);
		const commentBinding = defineCrudBinding({
			resource: commentResource,
			adapter: { useValue: commentAdapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				persistence: (values) => values,
				response: (record, _relations, projected) => ({
					id: Number(record.id),
					articleId: Number(record.articleId),
					...(typeof projected?.score === "number" ? { score: projected.score } : {}),
				}),
			},
		});

		const articleAdapter = new FakeCrudAdapter([
			{ id: 1, title: "First" },
			{ id: 2, title: "Second" },
		]);
		const parentBinding = defineCrudBinding({
			resource: articleWithComments,
			adapter: { useValue: articleAdapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				persistence: (values) => values,
				response: (record, relations) => ({
					id: Number(record.id),
					comments: Array.isArray(relations.comments) ? relations.comments : [],
				}),
			},
		});

		const commentService = new CrudService(
			commentResource,
			commentBinding,
			commentAdapter,
			[],
			[],
			registry,
			options,
			undefined,
			[scores],
		);
		const articleService = new CrudService(
			articleWithComments,
			parentBinding,
			articleAdapter,
			[],
			[],
			registry,
			options,
		);
		registry.register(commentBinding, commentService);
		registry.register(parentBinding, articleService);
		registry.onApplicationBootstrap();

		const page = await articleService.list({ page: "1", limit: "10", include: "comments" });

		expect(project).toHaveBeenCalledTimes(1);
		expect(commentAdapter.events).toEqual(["transaction:begin", "transaction:commit"]);
		expect(articleAdapter.events).toEqual(["transaction:begin", "transaction:commit"]);
		expect(page.data).toEqual([
			{
				id: 1,
				comments: [
					{ id: 10, articleId: 1, score: 1000 },
					{ id: 11, articleId: 1, score: 1100 },
				],
			},
			{ id: 2, comments: [{ id: 12, articleId: 2, score: 1200 }] },
		]);
	});
});
