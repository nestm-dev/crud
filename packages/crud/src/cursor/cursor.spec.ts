import { describe, expect, it } from "vitest";

import { buildCrudCursorPredicate } from "./cursor-predicate.ts";
import { decodeCrudCursor, encodeCrudCursor } from "./cursor.ts";
import { CrudCursorError } from "./cursor.error.ts";
import { CRUD_CURSOR_VERSION } from "./cursor.types.ts";
import { HmacSha256CrudCursorCodec } from "./hmac-sha256-cursor-codec.ts";
import { InsecureCrudCursorCodec } from "./insecure-cursor-codec.ts";

const SECRET = "a production-length cursor secret with 32+ bytes";

describe("HmacSha256CrudCursorCodec", () => {
	it("round-trips a bound, versioned cursor and database scalar values", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [
			{ field: "createdAt", direction: "desc" },
			{ field: "id", direction: "asc" },
		] as const;
		const createdAt = new Date("2026-08-01T12:00:00.000Z");
		const token = await encodeCrudCursor(codec, { resource: "users", order }, [createdAt, 42n]);

		expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		await expect(decodeCrudCursor(codec, token, { resource: "users", order })).resolves.toEqual({
			version: CRUD_CURSOR_VERSION,
			resource: "users",
			order,
			values: [createdAt, 42n],
		});
	});

	it("round-trips nested JSON-compatible values and bytes without tag collisions", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "key", direction: "asc" }] as const;
		const value = {
			type: "date",
			value: [true, null, Uint8Array.from([1, 2, 255])],
		};
		const token = await encodeCrudCursor(codec, { resource: "records", order }, [value]);

		const decoded = await decodeCrudCursor(codec, token, { resource: "records", order });
		expect(decoded.values).toEqual([value]);
	});

	it("rejects short secrets", () => {
		expect(() => new HmacSha256CrudCursorCodec("too-short")).toThrowError(
			expect.objectContaining({ code: "invalid_secret" }),
		);
	});

	it("rejects tampered signatures", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "id", direction: "asc" }] as const;
		const token = await encodeCrudCursor(codec, { resource: "users", order }, [1]);
		const lastCharacter = token.at(-1);
		const tampered = `${token.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;

		expect(() => codec.decode(tampered)).toThrowError(
			expect.objectContaining({ code: "invalid_signature" }),
		);
	});

	it("rejects reuse for another resource or ordering", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "id", direction: "asc" }] as const;
		const token = await encodeCrudCursor(codec, { resource: "users", order }, [1]);

		await expect(
			decodeCrudCursor(codec, token, { resource: "admins", order }),
		).rejects.toMatchObject({ code: "binding_mismatch" });
		await expect(
			decodeCrudCursor(codec, token, {
				resource: "users",
				order: [{ field: "id", direction: "desc" }],
			}),
		).rejects.toMatchObject({ code: "binding_mismatch" });
	});

	it("binds a cursor to fixed nested collection values", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [
			{ field: "rank", direction: "asc" },
			{ field: "artifactId", direction: "asc" },
			{ field: "id", direction: "asc" },
		] as const;
		const values = [10, "artifact-a", 7] as const;
		const binding = {
			resource: "artifact-versions",
			order,
			fixed: [{ field: "artifactId", value: "artifact-a" }],
		} as const;
		const token = await encodeCrudCursor(codec, binding, values);

		await expect(decodeCrudCursor(codec, token, binding)).resolves.toMatchObject({ values });
		await expect(
			decodeCrudCursor(codec, token, {
				...binding,
				fixed: [{ field: "artifactId", value: "artifact-b" }],
			}),
		).rejects.toMatchObject({ code: "binding_mismatch" });
		await expect(
			encodeCrudCursor(
				codec,
				{
					...binding,
					fixed: [{ field: "artifactId", value: "artifact-b" }],
				},
				values,
			),
		).rejects.toMatchObject({ code: "binding_mismatch" });
	});

	it("compares fixed cursor values losslessly", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "parent", direction: "asc" }] as const;
		const parent = {
			createdAt: new Date("2026-08-01T12:00:00.000Z"),
			key: Uint8Array.from([1, 2, 255]),
			sequence: 42n,
			labels: ["a", null],
		};
		const token = await encodeCrudCursor(
			codec,
			{ resource: "nested", order, fixed: [{ field: "parent", value: parent }] },
			[parent],
		);

		await expect(
			decodeCrudCursor(codec, token, {
				resource: "nested",
				order,
				fixed: [
					{
						field: "parent",
						value: {
							labels: ["a", null],
							sequence: 42n,
							key: Uint8Array.from([1, 2, 255]),
							createdAt: new Date("2026-08-01T12:00:00.000Z"),
						},
					},
				],
			}),
		).resolves.toMatchObject({ values: [parent] });
	});

	it("rejects fixed fields missing from or duplicated in the cursor order", async () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		await expect(
			encodeCrudCursor(
				codec,
				{
					resource: "nested",
					order: [{ field: "id", direction: "asc" }],
					fixed: [{ field: "parentId", value: 1 }],
				},
				[1],
			),
		).rejects.toMatchObject({ code: "binding_mismatch" });
		await expect(
			encodeCrudCursor(
				codec,
				{
					resource: "nested",
					order: [
						{ field: "parentId", direction: "asc" },
						{ field: "parentId", direction: "desc" },
					],
					fixed: [{ field: "parentId", value: 1 }],
				},
				[1, 1],
			),
		).rejects.toMatchObject({ code: "binding_mismatch" });
	});

	it("rejects cyclic or non-finite cursor values", () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "id", direction: "asc" }] as const;
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;

		expect(() =>
			codec.encode({
				version: CRUD_CURSOR_VERSION,
				resource: "users",
				order,
				values: [cyclic],
			}),
		).toThrowError(CrudCursorError);
		expect(() =>
			codec.encode({
				version: CRUD_CURSOR_VERSION,
				resource: "users",
				order,
				values: [Number.NaN],
			}),
		).toThrowError(CrudCursorError);
	});

	it("rejects nullable top-level keyset values while preserving nested nulls", () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "id", direction: "asc" }] as const;

		expect(() =>
			codec.encode({
				version: CRUD_CURSOR_VERSION,
				resource: "users",
				order,
				values: [null],
			}),
		).toThrowError(CrudCursorError);
	});

	it("never emits a token that its decoder length limit rejects", () => {
		const codec = new HmacSha256CrudCursorCodec(SECRET);
		const order = [{ field: "id", direction: "asc" }] as const;

		expect(() =>
			codec.encode({
				version: CRUD_CURSOR_VERSION,
				resource: "users",
				order,
				values: ["x".repeat(20_000)],
			}),
		).toThrowError(CrudCursorError);
	});
});

describe("InsecureCrudCursorCodec", () => {
	it("is deterministic across test instances", async () => {
		const order = [{ field: "id", direction: "asc" }] as const;
		const first = new InsecureCrudCursorCodec();
		const second = new InsecureCrudCursorCodec();
		const token = await encodeCrudCursor(first, { resource: "users", order }, [1]);

		await expect(
			decodeCrudCursor(second, token, { resource: "users", order }),
		).resolves.toMatchObject({
			values: [1],
		});
	});
});

describe("buildCrudCursorPredicate", () => {
	it("builds a mixed-direction lexicographic keyset predicate", () => {
		expect(
			buildCrudCursorPredicate(
				[
					{ field: "score", direction: "desc" },
					{ field: "name", direction: "asc" },
					{ field: "id", direction: "asc" },
				],
				[100, "Ada", 7],
			),
		).toEqual({
			kind: "or",
			predicates: [
				{ kind: "comparison", field: "score", operator: "lt", value: 100 },
				{
					kind: "and",
					predicates: [
						{ kind: "comparison", field: "score", operator: "eq", value: 100 },
						{ kind: "comparison", field: "name", operator: "gt", value: "Ada" },
					],
				},
				{
					kind: "and",
					predicates: [
						{ kind: "comparison", field: "score", operator: "eq", value: 100 },
						{ kind: "comparison", field: "name", operator: "eq", value: "Ada" },
						{ kind: "comparison", field: "id", operator: "gt", value: 7 },
					],
				},
			],
		});
	});

	it("rejects nullable cursor values and arity mismatches", () => {
		expect(() =>
			buildCrudCursorPredicate([{ field: "id", direction: "asc" }], [null]),
		).toThrowError(CrudCursorError);
		expect(() => buildCrudCursorPredicate([{ field: "id", direction: "asc" }], [])).toThrowError(
			CrudCursorError,
		);
	});
});
