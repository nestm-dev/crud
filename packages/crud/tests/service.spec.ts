import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import type { CrudAdapter } from "../src/adapter/adapter.types.ts";
import { HmacSha256CrudCursorCodec } from "../src/cursor/hmac-sha256-cursor-codec.ts";
import { resolveCrudModuleOptions } from "../src/module/crud-module.options.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import { CrudService } from "../src/runtime/crud.service.ts";
import type { CrudLifecycleHook, CrudScope } from "../src/runtime/runtime.types.ts";
import {
	SOFT_DELETE_TIME,
	compositeResource,
	createCompositeBinding,
	createUserService,
	userResource,
} from "./support/core-fixtures.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

describe("CrudService visibility and identity", () => {
	it("rejects a global relation bound without overflow headroom", () => {
		expect(() =>
			resolveCrudModuleOptions({ maxRelatedRows: Number.MAX_SAFE_INTEGER }),
		).toThrowError(/below Number\.MAX_SAFE_INTEGER/u);
	});

	it("rejects an adapter result that omits a requested offset total", async () => {
		const adapter = new FakeCrudAdapter([
			{ id: 1, tenantId: "tenant-a", name: "Visible", deletedAt: null },
		]);
		const findMany = adapter.findMany.bind(adapter);
		vi.spyOn(adapter, "findMany").mockImplementation(async (input, context) => {
			const result = await findMany(input, context);
			return { records: result.records };
		});
		const { service } = createUserService({ adapter });

		await expect(service.list({ page: "1" })).rejects.toMatchObject({ status: 500 });
	});

	it("rejects a non-safe adapter count", async () => {
		const adapter = new FakeCrudAdapter([
			{ id: 1, tenantId: "tenant-a", name: "Visible", deletedAt: null },
		]);
		vi.spyOn(adapter, "findMany").mockResolvedValue({
			records: [],
			total: Number.MAX_SAFE_INTEGER + 1,
		});
		const { service } = createUserService({ adapter });

		await expect(service.list({ page: "1" })).rejects.toMatchObject({ status: 500 });
	});

	it("applies scopes to reads and applies create values only while inserting", async () => {
		const adapter = new FakeCrudAdapter([
			{
				id: 1,
				tenantId: "tenant-a",
				ownerId: "original-owner",
				name: "Visible",
				deletedAt: null,
			},
			{ id: 2, tenantId: "tenant-b", name: "Hidden", deletedAt: null },
		]);
		const tenantScope: CrudScope<typeof userResource> = {
			resolve: () => ({
				predicate: {
					kind: "comparison",
					field: "tenantId",
					operator: "eq",
					value: "tenant-a",
				},
				createValues: { tenantId: "tenant-a", ownerId: "current-admin" },
			}),
		};
		const { service } = createUserService({ adapter, scopes: [tenantScope] });

		await expect(service.read({ id: 2 })).rejects.toMatchObject({ status: 404 });
		await expect(service.list({ page: "1" })).resolves.toMatchObject({
			data: [{ id: 1, tenantId: "tenant-a", name: "Visible" }],
			meta: { mode: "offset", total: 1 },
		});
		await expect(
			service.create({ name: "Scoped create", tenantId: "tenant-b" }),
		).resolves.toMatchObject({ tenantId: "tenant-a" });
		expect(adapter.snapshot().at(-1)).toMatchObject({ tenantId: "tenant-a" });

		await service.update({ id: 1 }, { name: "Updated by admin" });
		expect(adapter.snapshot()[0]).toMatchObject({
			name: "Updated by admin",
			ownerId: "original-owner",
		});
	});

	it("applies only explicitly declared scope update values to updates", async () => {
		const adapter = new FakeCrudAdapter([
			{ id: 1, tenantId: "tenant-a", name: "Before", deletedAt: null },
		]);
		const scope: CrudScope<typeof userResource> = {
			resolve: () => ({
				predicate: {
					kind: "comparison",
					field: "tenantId",
					operator: "eq",
					value: "tenant-a",
				},
				createValues: { tenantId: "create-only" },
				updateValues: { tenantId: "explicit-update" },
			}),
		};
		const { service } = createUserService({ adapter, scopes: [scope] });

		await service.update({ id: 1 }, { name: "After" });
		expect(adapter.snapshot()[0]).toMatchObject({
			name: "After",
			tenantId: "explicit-update",
		});
	});

	it("fails closed when a declared scope-owned create field is not materialized", async () => {
		type ScopedCreateValues = {
			readonly name: string;
			readonly tenantId: string;
			readonly deletedAt: null;
		};
		const adapter = new FakeCrudAdapter();
		const typedAdapter: CrudAdapter<
			Record<string, unknown>,
			ScopedCreateValues,
			Partial<ScopedCreateValues>
		> = adapter;
		const scopeCreateFields: "tenantId"[] = ["tenantId"];
		const binding = defineCrudBinding({
			resource: userResource,
			adapter: { useValue: typedAdapter },
			fields: ["id", "name", "tenantId", "deletedAt"],
			scopeCreateFields,
			mappings: {
				create: (input) => ({ name: input.name, deletedAt: null }),
				update: () => ({}),
				persistence: () => ({}),
				response: (record) => ({
					id: Number(record.id),
					name: String(record.name),
					tenantId: String(record.tenantId),
					deletedAt: null,
				}),
			},
		});
		scopeCreateFields.push("tenantId");
		expect(binding.scopeCreateFields).toEqual(["tenantId"]);
		expect(Object.isFrozen(binding.scopeCreateFields)).toBe(true);
		const service = new CrudService(
			userResource,
			binding,
			typedAdapter,
			[],
			[{ resolve: () => ({ createValues: {} }) }],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
		);

		await expect(service.create({ name: "Rejected" })).rejects.toMatchObject({ status: 500 });
		expect(adapter.calls.create).toBe(0);
	});

	it("uses every composite ID component when reading", async () => {
		const adapter = new FakeCrudAdapter([
			{ tenantId: "tenant-a", id: 7, role: "reader" },
			{ tenantId: "tenant-b", id: 7, role: "admin" },
		]);
		const registry = new CrudRegistry();
		const service = new CrudService(
			compositeResource,
			createCompositeBinding(adapter),
			adapter,
			[],
			[],
			registry,
			resolveCrudModuleOptions({}),
		);

		await expect(service.read({ tenantId: "tenant-b", id: 7 })).resolves.toEqual({
			tenantId: "tenant-b",
			id: 7,
			role: "admin",
		});
		await expect(service.read({ tenantId: "tenant-c", id: 7 })).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe("CrudService cursor pagination", () => {
	it("round-trips stable non-null keysets", async () => {
		const service = createCursorService([
			{ id: 1, rank: 10 },
			{ id: 2, rank: 20 },
			{ id: 3, rank: 30 },
		]);

		const first = await service.list({});
		expect(first).toMatchObject({
			data: [{ id: 1, rank: 10 }],
			meta: { mode: "cursor", hasNextPage: true },
		});
		if (first.meta.mode !== "cursor" || first.meta.nextCursor === null) {
			throw new TypeError("Expected a cursor page.");
		}
		await expect(service.list({ after: first.meta.nextCursor })).resolves.toMatchObject({
			data: [{ id: 2, rank: 20 }],
			meta: { mode: "cursor", hasNextPage: true },
		});
	});

	it("never emits a cursor containing a nullable ordered value", async () => {
		const service = createCursorService([
			{ id: 1, rank: null },
			{ id: 2, rank: 20 },
		]);

		await expect(service.list({})).rejects.toMatchObject({ status: 500 });
	});
});

describe("CrudService transaction and lifecycle semantics", () => {
	it("maps adapter errors from a duplicated package copy", async () => {
		const adapter = new FakeCrudAdapter();
		vi.spyOn(adapter, "create").mockRejectedValue({
			name: "CrudAdapterError",
			code: "conflict",
			message: "duplicate package error",
			retryable: false,
		});
		const { service } = createUserService({ adapter });

		await expect(service.create({ name: "Duplicate", tenantId: "tenant-a" })).rejects.toMatchObject(
			{ status: 409 },
		);
	});

	it("runs before/after hooks inside the transaction and afterCommit after commit", async () => {
		const events: string[] = [];
		const adapter = new FakeCrudAdapter([], {}, events);
		const hook: CrudLifecycleHook<typeof userResource> = {
			beforeCreate: (input, context) => {
				events.push("hook:beforeCreate");
				expect(context.session).toBeDefined();
				return { ...input, name: input.name.toUpperCase() };
			},
			afterCreate: (_record, context) => {
				events.push("hook:afterCreate");
				expect(context.session).toBeDefined();
			},
			afterCommit: (event) => {
				events.push("hook:afterCommit");
				expect(event.operation).toBe("create");
				expect(event.response).toMatchObject({ name: "CREATED" });
			},
		};
		const { service } = createUserService({ adapter, hooks: [hook] });

		await expect(service.create({ name: "Created", tenantId: "tenant-a" })).resolves.toMatchObject({
			name: "CREATED",
		});
		expect(events).toEqual([
			"transaction:begin",
			"hook:beforeCreate",
			"hook:afterCreate",
			"transaction:commit",
			"hook:afterCommit",
		]);
	});

	it("rolls back when an in-transaction hook fails and does not call afterCommit", async () => {
		const afterCommit = vi.fn();
		const hook: CrudLifecycleHook<typeof userResource> = {
			afterCreate: () => {
				throw new Error("reject mutation");
			},
			afterCommit,
		};
		const { adapter, service } = createUserService({ hooks: [hook] });

		await expect(
			service.create({ name: "Rolled back", tenantId: "tenant-a" }),
		).rejects.toMatchObject({
			status: 500,
		});
		expect(adapter.snapshot()).toEqual([]);
		expect(adapter.events).toEqual(["transaction:begin", "transaction:rollback"]);
		expect(afterCommit).not.toHaveBeenCalled();
	});

	it("reports afterCommit failures without pretending the committed mutation rolled back", async () => {
		const sink = vi.fn();
		const failure = new Error("delivery failed");
		const hook: CrudLifecycleHook<typeof userResource> = {
			afterCommit: () => {
				throw failure;
			},
		};
		const { adapter, service } = createUserService({
			afterCommitErrorHandler: sink,
			hooks: [hook],
		});

		await expect(
			service.create({ name: "Committed", tenantId: "tenant-a" }),
		).resolves.toMatchObject({
			name: "Committed",
		});
		expect(adapter.snapshot()).toHaveLength(1);
		expect(adapter.events).toEqual(["transaction:begin", "transaction:commit"]);
		expect(sink).toHaveBeenCalledWith(
			expect.objectContaining({
				error: failure,
				hook,
				event: expect.objectContaining({ operation: "create" }),
			}),
		);
	});
});

describe("CrudService soft deletion", () => {
	it("logically deletes, hides normal reads, supports deleted-only lists, and restores", async () => {
		const adapter = new FakeCrudAdapter([
			{ id: 1, tenantId: "tenant-a", name: "Soft", deletedAt: null },
		]);
		const { service } = createUserService({ adapter });

		await expect(service.delete({ id: 1 })).resolves.toBeUndefined();
		expect(adapter.calls.delete).toBe(0);
		expect(adapter.calls.update).toBe(1);
		expect(adapter.snapshot()[0]?.deletedAt).toEqual(SOFT_DELETE_TIME);
		await expect(service.read({ id: 1 })).rejects.toMatchObject({ status: 404 });
		await expect(service.list({ page: "1" })).resolves.toMatchObject({
			data: [],
			meta: { total: 0 },
		});
		await expect(service.list({ page: "1", deleted: "only" })).resolves.toMatchObject({
			data: [{ id: 1, deletedAt: SOFT_DELETE_TIME }],
			meta: { total: 1 },
		});

		await expect(service.restore({ id: 1 })).resolves.toMatchObject({ id: 1, deletedAt: null });
		await expect(service.read({ id: 1 })).resolves.toMatchObject({ id: 1, deletedAt: null });
	});
});

describe("CrudService persistence field mapping", () => {
	it("maps scoped and soft-delete logical values before every adapter write", async () => {
		const resource = defineCrudResource({
			name: "aliased-users",
			path: "aliased-users",
			itemPath: ":id",
			idFields: { id: "id" },
			contracts: {
				id: z.object({ id: z.coerce.number().int() }),
				create: z.object({ name: z.string(), tenantId: z.string().optional() }),
				update: z.object({ name: z.string().optional() }),
				response: z.object({
					id: z.number(),
					name: z.string(),
					tenantId: z.string(),
					deletedAt: z.date().nullable(),
				}),
			},
			operations: crudOperations.all({ restore: {} }),
			softDelete: {
				field: "deletedAt",
				deleteValue: () => SOFT_DELETE_TIME,
				restoreValue: () => null,
			},
		});
		const fieldKeys = {
			id: "record_id",
			name: "display_name",
			tenantId: "tenant_key",
			deletedAt: "removed_on",
		} as const;
		const adapter = new FakeCrudAdapter([], {}, [], fieldKeys);
		const binding = defineCrudBinding({
			resource,
			adapter: { useValue: adapter },
			fields: ["id", "name", "tenantId", "deletedAt"],
			mappings: {
				create: (input) => ({ display_name: input.name, removed_on: null }),
				update: (input) => (input.name === undefined ? {} : { display_name: input.name }),
				persistence: (values) => mapFieldValues(values, fieldKeys),
				response: (record) => {
					const deletedAt = record.removed_on;
					if (deletedAt !== null && !(deletedAt instanceof Date)) {
						throw new TypeError("removed_on must be a Date or null.");
					}
					return {
						id: requiredNumber(record.record_id),
						name: requiredString(record.display_name),
						tenantId: requiredString(record.tenant_key),
						deletedAt,
					};
				},
			},
		});
		const scope: CrudScope<typeof resource> = {
			resolve: () => ({
				predicate: {
					kind: "comparison",
					field: "tenantId",
					operator: "eq",
					value: "tenant-scope",
				},
				createValues: { tenantId: "tenant-scope" },
			}),
		};
		const service = new CrudService(
			resource,
			binding,
			adapter,
			[],
			[scope],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
		);

		await expect(service.create({ name: "Created", tenantId: "client" })).resolves.toMatchObject({
			id: 1,
			tenantId: "tenant-scope",
		});
		expect(adapter.snapshot()).toEqual([
			{
				record_id: 1,
				display_name: "Created",
				tenant_key: "tenant-scope",
				removed_on: null,
			},
		]);

		await expect(service.update({ id: 1 }, { name: "Updated" })).resolves.toMatchObject({
			name: "Updated",
			tenantId: "tenant-scope",
		});
		await service.delete({ id: 1 });
		expect(adapter.snapshot()[0]?.removed_on).toEqual(SOFT_DELETE_TIME);
		await expect(service.restore({ id: 1 })).resolves.toMatchObject({ deletedAt: null });
		expect(adapter.snapshot()[0]?.removed_on).toBeNull();
	});
});

describe("CrudService bounded relations", () => {
	it("maps a one-hop relation and rejects a hasMany result over its configured bound", async () => {
		const oneChild = createRelationServices([{ id: 10, parentId: 1, name: "Only child" }]);
		await expect(oneChild.parentService.read({ id: 1 }, undefined, ["children"])).resolves.toEqual({
			id: 1,
			name: "Parent",
			children: [{ id: 10, parentId: 1, name: "Only child" }],
		});

		const tooMany = createRelationServices([
			{ id: 10, parentId: 1, name: "First" },
			{ id: 11, parentId: 1, name: "Second" },
		]);
		await expect(
			tooMany.parentService.read({ id: 1 }, undefined, ["children"]),
		).rejects.toMatchObject({ status: 422 });
	});
});

const childResource = defineCrudResource({
	name: "children",
	path: "children",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number() }),
		create: z.object({ parentId: z.number(), name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), parentId: z.number(), name: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
});

const cursorResource = defineCrudResource({
	name: "cursor-records",
	path: "cursor-records",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ rank: z.number().nullable() }),
		update: z.object({ rank: z.number().nullable().optional() }),
		response: z.object({ id: z.number(), rank: z.number().nullable() }),
	},
	operations: crudOperations.readOnly(),
	query: {
		sort: { fields: ["rank", "id"], default: ["rank"], cursor: ["rank"] },
		pagination: { cursor: true, defaultLimit: 1, maxLimit: 5 },
	},
});

function createCursorService(records: readonly Record<string, unknown>[]) {
	const adapter = new FakeCrudAdapter(records);
	const binding = defineCrudBinding({
		resource: cursorResource,
		adapter: { useValue: adapter },
		fields: ["id", "rank"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				id: requiredNumber(record.id),
				rank: record.rank === null ? null : requiredNumber(record.rank),
			}),
		},
	});
	return new CrudService(
		cursorResource,
		binding,
		adapter,
		[],
		[],
		new CrudRegistry(),
		resolveCrudModuleOptions({}),
		new HmacSha256CrudCursorCodec("a secure cursor secret with at least thirty-two bytes"),
	);
}

const parentResource = defineCrudResource({
	name: "parents",
	path: "parents",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({
			id: z.number(),
			name: z.string(),
			children: z.array(z.object({ id: z.number(), parentId: z.number(), name: z.string() })),
		}),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
	relations: {
		children: {
			type: "hasMany",
			target: () => childResource,
			local: ["id"],
			foreign: ["parentId"],
			maxItems: 1,
		},
	},
});

function createRelationServices(children: readonly Record<string, unknown>[]) {
	const registry = new CrudRegistry();
	const childAdapter = new FakeCrudAdapter(children);
	const parentAdapter = new FakeCrudAdapter([{ id: 1, name: "Parent" }]);
	const childBinding = defineCrudBinding({
		resource: childResource,
		adapter: { useValue: childAdapter },
		fields: ["id", "parentId", "name"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				id: requiredNumber(record.id),
				parentId: requiredNumber(record.parentId),
				name: requiredString(record.name),
			}),
		},
	});
	const parentBinding = defineCrudBinding({
		resource: parentResource,
		adapter: { useValue: parentAdapter },
		fields: ["id", "name"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record, relations) => ({
				id: requiredNumber(record.id),
				name: requiredString(record.name),
				children: Array.isArray(relations.children) ? relations.children.map(readChild) : [],
			}),
		},
	});
	const options = resolveCrudModuleOptions({});
	const childService = new CrudService(
		childResource,
		childBinding,
		childAdapter,
		[],
		[],
		registry,
		options,
	);
	const parentService = new CrudService(
		parentResource,
		parentBinding,
		parentAdapter,
		[],
		[],
		registry,
		options,
	);
	registry.register(childBinding, childService);
	registry.register(parentBinding, parentService);
	registry.onApplicationBootstrap();
	return { childService, parentService };
}

function readChild(value: unknown) {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Expected a child relation record.");
	}
	return {
		id: requiredNumber("id" in value ? value.id : undefined),
		parentId: requiredNumber("parentId" in value ? value.parentId : undefined),
		name: requiredString("name" in value ? value.name : undefined),
	};
}

function mapFieldValues(
	values: Readonly<Record<string, unknown>>,
	keys: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
	return Object.fromEntries(
		Object.entries(values).map(([field, value]) => [keys[field] ?? field, value]),
	);
}

function requiredNumber(value: unknown): number {
	if (typeof value !== "number") throw new TypeError("Expected a number.");
	return value;
}

function requiredString(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string.");
	return value;
}
