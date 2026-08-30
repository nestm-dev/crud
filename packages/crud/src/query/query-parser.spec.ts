import { z } from "zod";
import { describe, expect, it } from "vitest";

import { encodeCrudCursor } from "../cursor/cursor.ts";
import { HmacSha256CrudCursorCodec } from "../cursor/hmac-sha256-cursor-codec.ts";
import { defineCrudResource } from "../resource/define-resource.ts";
import { crudOperations } from "../resource/operations.ts";
import { buildCrudOrder, parseCrudListQuery } from "./query-parser.ts";
import { CrudQueryValidationError } from "./query.error.ts";
import { resolveCrudPaginationModes } from "./pagination.ts";

const SECRET = "a production-length cursor secret with 32+ bytes";
const codec = new HmacSha256CrudCursorCodec(SECRET);

const userResource = defineCrudResource({
	fields: ["id", "name", "age", "createdAt", "deletedAt"],
	name: "users",
	path: "users",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int().positive() }),
		create: z.object({ name: z.string(), age: z.number() }),
		update: z.object({ name: z.string().optional(), age: z.number().optional() }),
		response: z.object({ id: z.number(), name: z.string(), age: z.number() }),
	},
	operations: crudOperations.all({ restore: {} }),
	query: {
		filters: {
			age: {
				schema: z.coerce.number().int(),
				operators: ["eq", "gte", "in", "nin", "between", "isnull"],
			},
			name: {
				schema: z.string().min(1),
				operators: ["eq", "contains", "icontains"],
			},
		},
		sort: {
			fields: ["id", "createdAt", "name"],
			default: ["-createdAt"],
			cursor: ["createdAt", "name"],
		},
		search: { fields: ["name"], minLength: 2, maxLength: 20 },
		pagination: { offset: true, cursor: true, defaultLimit: 2, maxLimit: 5 },
	},
	softDelete: { field: "deletedAt", allowQueryDeleted: true },
	relations: {
		posts: {
			type: "hasMany",
			target: () => {
				throw new Error("not evaluated by query parsing");
			},
			local: ["id"],
			foreign: ["userId"],
		},
	},
});

const membershipResource = defineCrudResource({
	fields: ["tenant_id", "id", "createdAt"],
	name: "memberships",
	path: "memberships",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenant_id", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string(), id: z.coerce.number() }),
		create: z.object({ tenantId: z.string(), id: z.number() }),
		update: z.object({}),
		response: z.object({ tenantId: z.string(), id: z.number() }),
	},
	operations: crudOperations.readOnly(),
	query: {
		sort: {
			fields: ["createdAt", "tenant_id", "id"],
			default: ["createdAt"],
			cursor: ["createdAt"],
		},
		pagination: { cursor: true },
	},
});

describe("parseCrudListQuery", () => {
	it("resolves offset-only, cursor-only, and explicit dual pagination modes", () => {
		expect(resolveCrudPaginationModes(undefined)).toEqual({ offset: true, cursor: false });
		expect(resolveCrudPaginationModes({ cursor: false })).toEqual({
			offset: true,
			cursor: false,
		});
		expect(resolveCrudPaginationModes({ cursor: true })).toEqual({
			offset: false,
			cursor: true,
		});
		expect(resolveCrudPaginationModes({ offset: true, cursor: true })).toEqual({
			offset: true,
			cursor: true,
		});
	});

	it("parses nested query objects, validates schemas, and ANDs filters", async () => {
		const query = await parseCrudListQuery(userResource, {
			filter: {
				age: { gte: "18", between: ["18", "65"], in: "21,34" },
				name: { contains: "Ada" },
			},
			sort: "-createdAt,name",
			search: "Ada",
			include: "posts",
			deleted: "include",
			page: "2",
			limit: "3",
		});

		expect(query).toEqual({
			mode: "offset",
			page: 2,
			limit: 3,
			predicate: {
				kind: "and",
				predicates: [
					{ kind: "comparison", field: "age", operator: "gte", value: 18 },
					{ kind: "comparison", field: "age", operator: "between", value: [18, 65] },
					{ kind: "comparison", field: "age", operator: "in", value: [21, 34] },
					{ kind: "comparison", field: "name", operator: "contains", value: "Ada" },
				],
			},
			order: [
				{ field: "createdAt", direction: "desc" },
				{ field: "name", direction: "asc" },
				{ field: "id", direction: "asc" },
			],
			search: "Ada",
			includes: ["posts"],
			deleted: "include",
		});
	});

	it("accepts literal bracket keys and repeated plural URL parameters", async () => {
		const raw = new URLSearchParams({ page: "1" });
		raw.append("filter[age][in]", "18");
		raw.append("filter[age][in]", "21");
		raw.append("filter[age][isnull]", "false");

		const query = await parseCrudListQuery(userResource, raw);
		expect(query.predicate).toEqual({
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "age", operator: "in", value: [18, 21] },
				{ kind: "comparison", field: "age", operator: "isnull", value: false },
			],
		});
	});

	it("uses cursor mode by default when enabled and appends the ID tie-breaker", async () => {
		const query = await parseCrudListQuery(userResource, {}, { cursorCodec: codec });
		expect(query).toMatchObject({
			mode: "cursor",
			limit: 2,
			order: [
				{ field: "createdAt", direction: "desc" },
				{ field: "id", direction: "asc" },
			],
		});
	});

	it("appends every composite ID field while preserving an explicit ID direction", () => {
		expect(buildCrudOrder(membershipResource, "-tenant_id", "cursor")).toEqual([
			{ field: "tenant_id", direction: "desc" },
			{ field: "id", direction: "asc" },
		]);
		expect(buildCrudOrder(membershipResource, undefined, "cursor")).toEqual([
			{ field: "createdAt", direction: "asc" },
			{ field: "tenant_id", direction: "asc" },
			{ field: "id", direction: "asc" },
		]);
	});

	it("does not accept page on a cursor-only resource", async () => {
		await expect(parseCrudListQuery(membershipResource, { page: "1" })).rejects.toMatchObject({
			code: "invalid_pagination",
			status: 400,
		});
	});

	it("rejects an offset that exceeds the safe integer range", async () => {
		await expect(
			parseCrudListQuery(userResource, {
				page: String(Number.MAX_SAFE_INTEGER),
				limit: "5",
			}),
		).rejects.toMatchObject({ code: "invalid_pagination", status: 400 });
	});

	it("verifies an after cursor and ANDs its keyset predicate with filters", async () => {
		const order = buildCrudOrder(userResource, "-createdAt", "cursor");
		const token = await encodeCrudCursor(codec, { resource: "users", order }, [100, 7]);
		const query = await parseCrudListQuery(
			userResource,
			{
				after: token,
				sort: "-createdAt",
				"filter[age][gte]": "18",
			},
			{ cursorCodec: codec },
		);

		expect(query.predicate).toEqual({
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "age", operator: "gte", value: 18 },
				{
					kind: "or",
					predicates: [
						{ kind: "comparison", field: "createdAt", operator: "lt", value: 100 },
						{
							kind: "and",
							predicates: [
								{ kind: "comparison", field: "createdAt", operator: "eq", value: 100 },
								{ kind: "comparison", field: "id", operator: "gt", value: 7 },
							],
						},
					],
				},
			],
		});
	});

	it("rejects cursor reuse with another ordering", async () => {
		const order = buildCrudOrder(userResource, "-createdAt", "cursor");
		const token = await encodeCrudCursor(codec, { resource: "users", order }, [100, 7]);

		await expect(
			parseCrudListQuery(userResource, { after: token, sort: "name" }, { cursorCodec: codec }),
		).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
	});

	it("rejects an after cursor issued for another fixed parent collection", async () => {
		const order = buildCrudOrder(membershipResource, undefined, "cursor");
		const token = await encodeCrudCursor(
			codec,
			{
				resource: membershipResource.name,
				order,
				fixed: [{ field: "tenant_id", value: "tenant-a" }],
			},
			[100, "tenant-a", 7],
		);

		await expect(
			parseCrudListQuery(
				membershipResource,
				{ after: token },
				{
					cursorCodec: codec,
					cursorFixedValues: [{ field: "tenant_id", value: "tenant-a" }],
				},
			),
		).resolves.toMatchObject({ mode: "cursor" });
		await expect(
			parseCrudListQuery(
				membershipResource,
				{ after: token },
				{
					cursorCodec: codec,
					cursorFixedValues: [{ field: "tenant_id", value: "tenant-b" }],
				},
			),
		).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
	});

	it.each([
		[{ page: "1", after: "token" }, "invalid_pagination"],
		[{ page: "1", limit: "6" }, "invalid_pagination"],
		[{ page: "1", sort: "unknown" }, "unknown_sort_field"],
		[{ page: "1", search: "x" }, "invalid_parameter"],
		[{ page: "1", include: "unknown" }, "unknown_include"],
		[{ page: ["1", "2"] }, "duplicate_parameter"],
		[{ page: "1", unexpected: "value" }, "unknown_parameter"],
	] as const)("rejects invalid query input %#", async (raw, code) => {
		await expect(parseCrudListQuery(userResource, raw)).rejects.toMatchObject({
			code,
			status: 400,
		});
	});

	it("rejects unknown filters, disabled operators, and scalar multiplicity", async () => {
		await expect(
			parseCrudListQuery(userResource, { page: "1", "filter[unknown][eq]": "1" }),
		).rejects.toMatchObject({ code: "unknown_filter_field" });
		await expect(
			parseCrudListQuery(userResource, { page: "1", "filter[age][lt]": "18" }),
		).rejects.toMatchObject({ code: "unknown_filter_operator" });
		await expect(
			parseCrudListQuery(userResource, { page: "1", "filter[age][eq]": ["1", "2"] }),
		).rejects.toMatchObject({ code: "invalid_filter_value" });
	});

	it.each(["__proto__", "constructor", "toString"])(
		"rejects prototype-named filter fields as normal 400 errors: %s",
		async (field) => {
			const raw = new URLSearchParams({ page: "1" });
			raw.set(`filter[${field}][eq]`, "value");

			await expect(parseCrudListQuery(userResource, raw)).rejects.toMatchObject({
				code: "unknown_filter_field",
				status: 400,
			});
		},
	);

	it("requires a codec only when an after token is supplied", async () => {
		await expect(parseCrudListQuery(userResource, { after: "token" })).rejects.toMatchObject({
			code: "cursor_codec_required",
		});
	});

	it("returns a Nest bad-request exception without leaking validation internals", async () => {
		const result = parseCrudListQuery(userResource, {
			page: "1",
			"filter[age][gte]": "not-a-number",
		});
		await expect(result).rejects.toBeInstanceOf(CrudQueryValidationError);
		await expect(result).rejects.toMatchObject({ status: 400, code: "invalid_filter_value" });
	});
});
