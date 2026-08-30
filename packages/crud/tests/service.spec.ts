import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import type { CrudAdapter } from "../src/adapter/adapter.types.ts";
import { HmacSha256CrudCursorCodec } from "../src/cursor/hmac-sha256-cursor-codec.ts";
import { resolveCrudModuleOptions } from "../src/module/crud-module.options.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import { CrudService } from "../src/runtime/crud.service.ts";
import { defineCrudFact, provideCrudFact } from "../src/runtime/crud-facts.ts";
import type {
	CrudLifecycleHook,
	CrudMutationValidator,
	CrudScope,
} from "../src/runtime/runtime.types.ts";
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
	it("keeps list and read scopes, queries, projections, and response mappings in one transaction", async () => {
		const scopeFact = defineCrudFact<string>("read-scope");
		const events: string[] = [];
		const adapter = new FakeCrudAdapter(
			[{ id: 1, name: "Visible", tenantId: "tenant-a", deletedAt: null }],
			{},
			events,
		);
		const findMany = adapter.findMany.bind(adapter);
		const findOne = adapter.findOne.bind(adapter);
		vi.spyOn(adapter, "findMany").mockImplementation((input, context) => {
			events.push("adapter:findMany");
			expect(context.session).toBeDefined();
			return findMany(input, context);
		});
		vi.spyOn(adapter, "findOne").mockImplementation((input, context) => {
			events.push("adapter:findOne");
			expect(context.session).toBeDefined();
			return findOne(input, context);
		});
		const binding = defineCrudBinding({
			resource: userResource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				persistence: (values) => values,
				response: (record) => {
					events.push("mapping:response");
					return {
						id: Number(record.id),
						name: String(record.name),
						tenantId: String(record.tenantId),
						deletedAt: record.deletedAt as Date | null,
					};
				},
			},
		});
		const service = new CrudService(
			userResource,
			binding,
			adapter,
			[],
			[
				{
					resolve: (context) => {
						events.push("scope");
						expect(context.session).toBeDefined();
						return { facts: [provideCrudFact(scopeFact, "visible")] };
					},
				},
			],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
			undefined,
			[
				{
					project: (records, context) => {
						events.push("projection");
						expect(context.session).toBeDefined();
						expect(context.facts.require(scopeFact)).toBe("visible");
						return records.map(() => ({}));
					},
				},
			],
		);

		await service.list({ page: "1" });
		expect(events).toEqual([
			"transaction:begin",
			"scope",
			"adapter:findMany",
			"projection",
			"mapping:response",
			"transaction:commit",
		]);

		events.length = 0;
		await service.read({ id: 1 });
		expect(events).toEqual([
			"transaction:begin",
			"scope",
			"adapter:findOne",
			"projection",
			"mapping:response",
			"transaction:commit",
		]);
	});

	it.each(["list", "read"] as const)("rolls back when a %s projection fails", async (operation) => {
		const adapter = new FakeCrudAdapter([
			{ id: 1, name: "Visible", tenantId: "tenant-a", deletedAt: null },
		]);
		const { service } = createUserService({
			adapter,
			projections: [
				{
					project: () => {
						throw new Error("projection failed");
					},
				},
			],
		});

		const result = operation === "list" ? service.list({ page: "1" }) : service.read({ id: 1 });
		await expect(result).rejects.toMatchObject({ status: 500 });
		expect(adapter.events).toEqual(["transaction:begin", "transaction:rollback"]);
	});

	it("passes hook-transformed input and typed scope facts to ordered validators", async () => {
		const parentFact = defineCrudFact<{ readonly id: string }>("authorized-parent");
		const events: string[] = [];
		const adapter = new FakeCrudAdapter([], {}, events);
		const scope: CrudScope<typeof userResource> = {
			resolve: (context) => {
				events.push("scope");
				expect(context.facts.has(parentFact)).toBe(false);
				return { facts: [provideCrudFact(parentFact, { id: "parent-1" })] };
			},
		};
		const hook: CrudLifecycleHook<typeof userResource> = {
			beforeCreate: (input, context) => {
				events.push("hook:beforeCreate");
				expect(context.facts.require(parentFact)).toEqual({ id: "parent-1" });
				return { ...input, name: input.name.toUpperCase() };
			},
			afterCreate: () => {
				events.push("hook:afterCreate");
			},
			afterCommit: (event) => {
				events.push("hook:afterCommit");
				expect(event).not.toHaveProperty("facts");
			},
		};
		const first: CrudMutationValidator<typeof userResource> = {
			validateCreate: (input, context) => {
				events.push("validator:first");
				expect(input.name).toBe("CREATED");
				expect(context.operation).toBe("create");
				expect(context.session).toBeDefined();
				expect(context.facts.require(parentFact).id).toBe("parent-1");
			},
		};
		const second: CrudMutationValidator<typeof userResource> = {
			validateCreate: () => {
				events.push("validator:second");
			},
		};
		const { service } = createUserService({
			adapter,
			hooks: [hook],
			scopes: [scope],
			validators: [first, second],
		});

		await expect(service.create({ name: "Created", tenantId: "tenant-a" })).resolves.toMatchObject({
			name: "CREATED",
		});
		expect(events).toEqual([
			"transaction:begin",
			"scope",
			"hook:beforeCreate",
			"validator:first",
			"validator:second",
			"hook:afterCreate",
			"transaction:commit",
			"hook:afterCommit",
		]);
	});

	it("fails closed and rolls back when scope facts are duplicate or missing", async () => {
		const fact = defineCrudFact<string>("required-value");
		const duplicate = createUserService({
			scopes: [
				{ resolve: () => ({ facts: [provideCrudFact(fact, "first")] }) },
				{ resolve: () => ({ facts: [provideCrudFact(fact, "second")] }) },
			],
		});
		await expect(
			duplicate.service.create({ name: "Rejected", tenantId: "tenant-a" }),
		).rejects.toMatchObject({ status: 500 });
		expect(duplicate.adapter.snapshot()).toEqual([]);
		expect(duplicate.adapter.events).toEqual(["transaction:begin", "transaction:rollback"]);

		const missing = createUserService({
			validators: [
				{
					validateCreate: (_input, context) => {
						context.facts.require(fact);
					},
				},
			],
		});
		await expect(
			missing.service.create({ name: "Rejected", tenantId: "tenant-a" }),
		).rejects.toMatchObject({ status: 500 });
		expect(missing.adapter.snapshot()).toEqual([]);
		expect(missing.adapter.events).toEqual(["transaction:begin", "transaction:rollback"]);
	});

	it("validates update, delete and restore after source visibility and before writes", async () => {
		const deletedAt = new Date("2026-07-01T00:00:00.000Z");
		const adapter = new FakeCrudAdapter([
			{ id: 1, name: "Update", tenantId: "tenant-a", deletedAt: null },
			{ id: 2, name: "Delete", tenantId: "tenant-a", deletedAt: null },
			{ id: 3, name: "Restore", tenantId: "tenant-a", deletedAt },
		]);
		const lifecycle: string[] = [];
		const hook: CrudLifecycleHook<typeof userResource> = {
			beforeUpdate: (input) => (lifecycle.push("hook:update"), { ...input, name: "FINAL" }),
			beforeDelete: () => {
				lifecycle.push("hook:delete");
			},
			beforeRestore: () => {
				lifecycle.push("hook:restore");
			},
		};
		const validator: CrudMutationValidator<typeof userResource> = {
			validateUpdate: (id, input, context) => {
				lifecycle.push("validator:update");
				expect(id).toEqual({ id: 1 });
				expect(input.name).toBe("FINAL");
				expect(context).toMatchObject({ operation: "update", session: expect.any(Object) });
			},
			validateDelete: (id, context) => {
				lifecycle.push("validator:delete");
				expect(id).toEqual({ id: 2 });
				expect(context).toMatchObject({ operation: "delete", session: expect.any(Object) });
			},
			validateRestore: (id, context) => {
				lifecycle.push("validator:restore");
				expect(id).toEqual({ id: 3 });
				expect(context).toMatchObject({ operation: "restore", session: expect.any(Object) });
			},
		};
		const { service } = createUserService({ adapter, hooks: [hook], validators: [validator] });

		await service.update({ id: 1 }, { name: "ignored" });
		await service.delete({ id: 2 });
		await service.restore({ id: 3 });
		expect(lifecycle).toEqual([
			"hook:update",
			"validator:update",
			"hook:delete",
			"validator:delete",
			"hook:restore",
			"validator:restore",
		]);
		expect(adapter.snapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 1, name: "FINAL" }),
				expect.objectContaining({ id: 2, deletedAt: SOFT_DELETE_TIME }),
				expect.objectContaining({ id: 3, deletedAt: null }),
			]),
		);
	});

	it.each(["update", "delete", "restore"] as const)(
		"returns 404 before %s validation when the source row is not visible",
		async (operation) => {
			const invoked = vi.fn();
			const adapter = new FakeCrudAdapter([
				{
					id: 999,
					name: "Scope hidden",
					tenantId: "tenant-a",
					deletedAt: operation === "restore" ? new Date("2026-07-01T00:00:00.000Z") : null,
				},
			]);
			const { service } = createUserService({
				adapter,
				scopes: [
					{
						resolve: () => ({
							predicate: {
								kind: "comparison",
								field: "tenantId",
								operator: "eq",
								value: "hidden-tenant",
							},
						}),
					},
				],
				validators: [
					{
						validateUpdate: invoked,
						validateDelete: invoked,
						validateRestore: invoked,
					},
				],
			});
			const mutation =
				operation === "update"
					? service.update({ id: 999 }, { name: "hidden" })
					: operation === "delete"
						? service.delete({ id: 999 })
						: service.restore({ id: 999 });

			await expect(mutation).rejects.toMatchObject({ status: 404 });
			expect(invoked).not.toHaveBeenCalled();
		},
	);

	it("preserves a validator HTTP exception and short-circuits every later mutation phase", async () => {
		const adapter = new FakeCrudAdapter();
		const afterCreate = vi.fn();
		const afterCommit = vi.fn();
		const { service } = createUserService({
			adapter,
			hooks: [{ afterCreate, afterCommit }],
			validators: [
				{
					validateCreate: () => {
						throw new NotFoundException("referenced resource was not found");
					},
				},
			],
		});

		await expect(service.create({ name: "Rejected", tenantId: "tenant-a" })).rejects.toMatchObject({
			status: 404,
			message: "referenced resource was not found",
		});
		expect(adapter.calls.create).toBe(0);
		expect(adapter.snapshot()).toEqual([]);
		expect(afterCreate).not.toHaveBeenCalled();
		expect(afterCommit).not.toHaveBeenCalled();
		expect(adapter.events).toEqual(["transaction:begin", "transaction:rollback"]);
	});

	it.each([
		["conflict", 409, true],
		["constraint", 400, false],
	] as const)(
		"maps %s adapter errors from a duplicated package copy",
		async (code, status, retryable) => {
			const adapter = new FakeCrudAdapter();
			const adapterError = {
				name: "CrudAdapterError",
				code,
				message: "duplicate package error",
				retryable,
			};
			vi.spyOn(adapter, "create").mockRejectedValue(adapterError);
			const { service } = createUserService({ adapter });

			await expect(
				service.create({ name: "Duplicate", tenantId: "tenant-a" }),
			).rejects.toMatchObject({ status, cause: adapterError });
		},
	);

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

describe("CrudService atomic upsert", () => {
	it("validates the full upsert id and hook-transformed input inside the transaction", async () => {
		const events: string[] = [];
		const adapter = new FakeCrudAdapter([], {}, events);
		const validator: CrudMutationValidator<typeof viewerBindingResource> = {
			validateUpsert: (id, input, context) => {
				events.push("validator:upsert");
				expect(id).toEqual({ artifactId: "artifact-1", serverId: "server-1" });
				expect(input.toolPrefix).toBe("FINAL");
				expect(context.session).toBeDefined();
			},
		};
		const service = createViewerBindingService(
			adapter,
			[{ beforeUpsert: (_id, input) => ({ ...input, toolPrefix: "FINAL" }) }],
			[viewerBindingScope()],
			[validator],
		);

		await service.upsert(
			{ artifactId: "artifact-1", serverId: "server-1" },
			{ toolPrefix: "requested" },
		);
		expect(events).toContain("validator:upsert");
		expect(adapter.snapshot()[0]).toMatchObject({ toolPrefix: "FINAL" });
	});

	it("uses one adapter upsert and dedicated hooks for insert and replacement", async () => {
		const events: string[] = [];
		const adapter = new FakeCrudAdapter([], {}, events);
		const upsertCall = vi.spyOn(adapter, "upsert");
		const resolveScope = vi.fn(() => ({ createValues: { viewerUserId: "viewer-1" } }));
		const scope: CrudScope<typeof viewerBindingResource> = { resolve: resolveScope };
		const hook: CrudLifecycleHook<typeof viewerBindingResource> = {
			beforeUpsert: (id, input, context) => {
				events.push("hook:beforeUpsert");
				expect(id).toEqual({ artifactId: "artifact-1", serverId: "server-1" });
				expect(context.session).toBeDefined();
				return { ...input, toolPrefix: input.toolPrefix.toUpperCase() };
			},
			afterUpsert: (_record, context) => {
				events.push("hook:afterUpsert");
				expect(context.session).toBeDefined();
			},
			afterCommit: (event) => {
				events.push("hook:afterCommit");
				expect(event).toMatchObject({ operation: "upsert" });
				expect(event.prior).toBeUndefined();
			},
		};
		const service = createViewerBindingService(adapter, [hook], [scope]);

		await expect(
			service.upsert({ artifactId: "artifact-1", serverId: "server-1" }, { toolPrefix: "first" }),
		).resolves.toMatchObject({ toolPrefix: "FIRST", alias: null });
		await expect(
			service.upsert({ artifactId: "artifact-1", serverId: "server-1" }, { toolPrefix: "second" }),
		).resolves.toMatchObject({ toolPrefix: "SECOND", alias: null });

		expect(adapter.calls).toMatchObject({ create: 0, findOne: 0, update: 0, upsert: 2 });
		expect(resolveScope).toHaveBeenCalledTimes(2);
		expect(adapter.snapshot()).toEqual([
			{
				artifactId: "artifact-1",
				viewerUserId: "viewer-1",
				serverId: "server-1",
				alias: null,
				toolPrefix: "SECOND",
			},
		]);
		expect(upsertCall).toHaveBeenLastCalledWith(
			{
				conflictFields: ["artifactId", "viewerUserId", "serverId"],
				overwriteFields: ["alias", "toolPrefix"],
				predicate: expect.any(Object),
				values: {
					artifactId: "artifact-1",
					viewerUserId: "viewer-1",
					serverId: "server-1",
					alias: null,
					toolPrefix: "SECOND",
				},
			},
			expect.objectContaining({ operation: "upsert", session: expect.any(Object) }),
		);
		expect(events).toEqual([
			"transaction:begin",
			"hook:beforeUpsert",
			"hook:afterUpsert",
			"transaction:commit",
			"hook:afterCommit",
			"transaction:begin",
			"hook:beforeUpsert",
			"hook:afterUpsert",
			"transaction:commit",
			"hook:afterCommit",
		]);
	});

	it("returns 404 without mutating a conflicting row hidden by the scope predicate", async () => {
		const record = {
			artifactId: "artifact-1",
			viewerUserId: "viewer-1",
			serverId: "server-1",
			alias: "preserved",
			toolPrefix: "old",
			visible: false,
		};
		const adapter = new FakeCrudAdapter([record]);
		const afterUpsert = vi.fn();
		const afterCommit = vi.fn();
		const service = createViewerBindingService(
			adapter,
			[{ afterUpsert, afterCommit }],
			[
				{
					resolve: () => ({
						createValues: { viewerUserId: "viewer-1" },
						predicate: {
							kind: "comparison",
							field: "visible",
							operator: "eq",
							value: true,
						},
					}),
				},
			],
		);

		await expect(
			service.upsert({ artifactId: "artifact-1", serverId: "server-1" }, { toolPrefix: "new" }),
		).rejects.toMatchObject({ status: 404 });
		expect(adapter.snapshot()).toEqual([record]);
		expect(afterUpsert).not.toHaveBeenCalled();
		expect(afterCommit).not.toHaveBeenCalled();
	});

	it.each(["capability", "method", "configuration", "mapping"] as const)(
		"fails bootstrap when atomic upsert %s is missing",
		(mode) => {
			const adapter = new FakeCrudAdapter([], mode === "capability" ? { upsert: false } : {});
			if (mode === "method") Object.defineProperty(adapter, "upsert", { value: undefined });
			const binding = createViewerBinding(adapter, {
				configure: mode !== "configuration",
				map: mode !== "mapping",
			});
			expect(
				() =>
					new CrudService(
						viewerBindingResource,
						binding,
						adapter,
						[],
						[viewerBindingScope()],
						new CrudRegistry(),
						resolveCrudModuleOptions({}),
					),
			).toThrow(/upsert/u);
		},
	);

	it.each([
		["duplicate conflict fields", ["artifactId", "artifactId"], ["alias"]],
		["empty conflict fields", [], ["alias"]],
		["duplicate overwrite fields", ["artifactId"], ["alias", "alias"]],
		["empty overwrite fields", ["artifactId"], []],
		["overlapping conflict and overwrite fields", ["artifactId"], ["artifactId"]],
		["overwriting a scope-owned field", ["artifactId"], ["viewerUserId"]],
	] as const)("rejects %s", (_label, conflictFields, overwriteFields) => {
		const adapter = new FakeCrudAdapter();
		const binding = { ...createViewerBinding(adapter) };
		Object.defineProperty(binding, "upsert", { value: { conflictFields, overwriteFields } });
		expect(
			() =>
				new CrudService(
					viewerBindingResource,
					binding,
					adapter,
					[],
					[viewerBindingScope()],
					new CrudRegistry(),
					resolveCrudModuleOptions({}),
				),
		).toThrow(/upsert|overwrite|repeats/u);
	});
});

describe("CrudService nested resource context", () => {
	it("constrains collection reads and materializes route-owned create values", async () => {
		const adapter = new FakeCrudAdapter([
			{ parentId: 1, id: 1, name: "First parent" },
			{ parentId: 2, id: 1, name: "Second parent" },
		]);
		const transaction = vi.spyOn(adapter, "transaction");
		const afterCommit = vi.fn();
		const contexts: unknown[] = [];
		const service = createNestedChildService(
			adapter,
			[{ resolve: (context) => (contexts.push(context), {}) }],
			[{ afterCommit }],
		);

		await expect(service.list({ page: "1" }, { parentId: 2 })).resolves.toMatchObject({
			data: [{ parentId: 2, id: 1, name: "Second parent" }],
			meta: { total: 1 },
		});
		await expect(service.create({ id: 2, name: "Created" }, { parentId: 2 })).resolves.toEqual({
			parentId: 2,
			id: 2,
			name: "Created",
		});
		await expect(
			service.update({ parentId: 2, id: 2 }, { name: "Updated" }),
		).resolves.toMatchObject({ name: "Updated" });
		await expect(service.read({ parentId: 2, id: 2 })).resolves.toMatchObject({ name: "Updated" });
		expect(adapter.snapshot()).toContainEqual({ parentId: 2, id: 2, name: "Updated" });
		expect(contexts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ operation: "list", pathParams: { parentId: 2 } }),
				expect.objectContaining({ operation: "create", pathParams: { parentId: 2 } }),
				expect.objectContaining({ operation: "update", pathParams: { parentId: 2 } }),
				expect.objectContaining({ operation: "read", pathParams: { parentId: 2 } }),
			]),
		);
		expect(transaction).toHaveBeenNthCalledWith(
			1,
			expect.any(Function),
			expect.objectContaining({ operation: "list", pathParams: { parentId: 2 } }),
		);
		expect(transaction).toHaveBeenNthCalledWith(
			2,
			expect.any(Function),
			expect.objectContaining({ operation: "create", pathParams: { parentId: 2 } }),
		);
		expect(transaction).toHaveBeenNthCalledWith(
			3,
			expect.any(Function),
			expect.objectContaining({ operation: "update", pathParams: { parentId: 2 } }),
		);
		expect(transaction).toHaveBeenNthCalledWith(
			4,
			expect.any(Function),
			expect.objectContaining({ operation: "read", pathParams: { parentId: 2 } }),
		);
		expect(afterCommit).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ operation: "create", pathParams: { parentId: 2 } }),
		);
		expect(afterCommit).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ operation: "update", pathParams: { parentId: 2 } }),
		);
	});

	it("fails closed when a trusted scope conflicts with a route-owned create value", async () => {
		const adapter = new FakeCrudAdapter();
		const service = createNestedChildService(adapter, [
			{ resolve: () => ({ createValues: { parentId: 99 } }) },
		]);

		await expect(
			service.create({ id: 1, name: "Rejected" }, { parentId: 1 }),
		).rejects.toMatchObject({ status: 500 });
		expect(adapter.calls.create).toBe(0);
	});

	it("coalesces an equal route-owned and scope-owned create value", async () => {
		const adapter = new FakeCrudAdapter();
		const service = createNestedChildService(adapter, [
			{ resolve: () => ({ createValues: { parentId: 1 } }) },
		]);

		await expect(service.create({ id: 1, name: "Accepted" }, { parentId: 1 })).resolves.toEqual({
			parentId: 1,
			id: 1,
			name: "Accepted",
		});
	});

	it("binds cursor tokens to one parent collection", async () => {
		const adapter = new FakeCrudAdapter([
			{ parentId: 1, id: 1, name: "One" },
			{ parentId: 1, id: 2, name: "Two" },
			{ parentId: 2, id: 1, name: "Other" },
		]);
		const service = createNestedChildService(adapter);
		const first = await service.list({}, { parentId: 1 });
		if (first.meta.mode !== "cursor" || first.meta.nextCursor === null) {
			throw new TypeError("Expected a nested cursor page.");
		}
		await expect(
			service.list({ after: first.meta.nextCursor }, { parentId: 2 }),
		).rejects.toMatchObject({ status: 400 });
	});

	it("requires explicit scope-create mapping for nested creates", () => {
		const adapter = new FakeCrudAdapter();
		const binding = defineCrudBinding({
			resource: nestedChildResource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				persistence: (values) => values,
				response: (record) => nestedChildResponse(record),
			},
		});
		expect(
			() =>
				new CrudService(
					nestedChildResource,
					binding,
					adapter,
					[],
					[],
					new CrudRegistry(),
					resolveCrudModuleOptions({}),
				),
		).toThrow(/scopeCreate/u);
	});

	it("requires explicit parent materialization for nested upsert-only resources", () => {
		const resource = defineCrudResource({
			fields: ["parentId", "id", "name"],
			name: "nested-upsert-only",
			path: "parents/:parentId/upsert-only",
			itemPath: ":id",
			idFields: { parentId: "parentId", id: "id" },
			pathParams: {
				contract: z.object({ parentId: z.coerce.number().int() }),
				fields: { parentId: "parentId" },
			},
			contracts: {
				id: z.object({ parentId: z.coerce.number().int(), id: z.coerce.number().int() }),
				create: z.object({ name: z.string() }),
				update: z.object({ name: z.string().optional() }),
				upsert: z.object({ name: z.string() }),
				response: z.object({ parentId: z.number(), id: z.number(), name: z.string() }),
			},
			operations: crudOperations.only("upsert"),
		});
		const adapter = new FakeCrudAdapter();
		const bindingOptions = {
			resource,
			adapter: { useValue: adapter },
			upsert: { conflictFields: ["parentId", "id"], overwriteFields: ["name"] } as const,
			mappings: {
				create: (input: { name: string }) => input,
				upsert: (id: { parentId: number; id: number }, input: { name: string }) => ({
					...id,
					...input,
				}),
				update: (input: { name?: string }) => input,
				persistence: (values: Readonly<Record<string, unknown>>) => values,
				response: (record: Record<string, unknown>) => nestedChildResponse(record),
			},
		};
		const withoutParentScope = defineCrudBinding(bindingOptions);

		expect(
			() =>
				new CrudService(
					resource,
					withoutParentScope,
					adapter,
					[],
					[],
					new CrudRegistry(),
					resolveCrudModuleOptions({}),
				),
		).toThrow(/scopeCreate/u);

		const withParentScope = defineCrudBinding({
			...bindingOptions,
			scopeCreateFields: ["parentId"],
		});
		expect(
			() =>
				new CrudService(
					resource,
					withParentScope,
					adapter,
					[],
					[],
					new CrudRegistry(),
					resolveCrudModuleOptions({}),
				),
		).not.toThrow();
	});
});

describe("CrudService soft deletion", () => {
	it("supports explicitly idempotent deletes without running mutation hooks for absent rows", async () => {
		const resource = defineCrudResource({
			fields: ["id", "name"],
			name: "idempotent-records",
			path: "idempotent-records",
			itemPath: ":id",
			idFields: { id: "id" },
			contracts: {
				id: z.object({ id: z.coerce.number().int() }),
				create: z.object({ name: z.string() }),
				update: z.object({ name: z.string().optional() }),
				response: z.object({ id: z.number(), name: z.string() }),
			},
			operations: { delete: { missing: "ignore" } },
		});
		const adapter = new FakeCrudAdapter([{ id: 1, name: "Existing" }]);
		const binding = defineCrudBinding({
			resource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				response: (record) => ({ id: Number(record.id), name: String(record.name) }),
			},
		});
		const beforeDelete = vi.fn();
		const afterDelete = vi.fn();
		const afterCommit = vi.fn();
		const service = new CrudService(
			resource,
			binding,
			adapter,
			[{ beforeDelete, afterDelete, afterCommit }],
			[],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
		);

		await expect(service.delete({ id: 1 })).resolves.toBeUndefined();
		await expect(service.delete({ id: 1 })).resolves.toBeUndefined();
		await expect(service.delete({ id: 999 })).resolves.toBeUndefined();

		expect(adapter.snapshot()).toEqual([]);
		expect(adapter.calls).toMatchObject({ findOne: 3, delete: 1 });
		expect(beforeDelete).toHaveBeenCalledTimes(1);
		expect(afterDelete).toHaveBeenCalledTimes(1);
		expect(afterCommit).toHaveBeenCalledTimes(1);
		expect(adapter.events).toEqual([
			"transaction:begin",
			"transaction:commit",
			"transaction:begin",
			"transaction:commit",
			"transaction:begin",
			"transaction:commit",
		]);
	});

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
	it("omits an empty persistence mapper and removes undefined mapper properties", async () => {
		const resource = defineCrudResource({
			fields: ["id", "name"],
			name: "direct-users",
			path: "direct-users",
			itemPath: ":id",
			idFields: { id: "id" },
			contracts: {
				id: z.object({ id: z.coerce.number().int() }),
				create: z.object({ name: z.string() }),
				update: z.object({ name: z.string().optional() }),
				response: z.object({ id: z.number(), name: z.string() }),
			},
			operations: crudOperations.all(),
		});
		const adapter = new FakeCrudAdapter([{ id: 1, name: "Before" }]);
		const binding = defineCrudBinding({
			resource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				response: (record) => ({
					id: requiredNumber(record.id),
					name: requiredString(record.name),
				}),
			},
		});
		const service = new CrudService(
			resource,
			binding,
			adapter,
			[],
			[],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
		);

		await expect(service.update({ id: 1 }, { name: undefined })).resolves.toEqual({
			id: 1,
			name: "Before",
		});
		expect(adapter.snapshot()).toEqual([{ id: 1, name: "Before" }]);
	});

	it("fails closed before mutation when generated values lack a persistence mapper", async () => {
		const resource = defineCrudResource({
			name: "unmapped-scope-users",
			fields: ["id", "name", "tenantId"],
			path: "unmapped-scope-users",
			itemPath: ":id",
			idFields: { id: "id" },
			contracts: {
				id: z.object({ id: z.coerce.number().int() }),
				create: z.object({ name: z.string() }),
				update: z.object({ name: z.string().optional() }),
				response: z.object({ id: z.number(), name: z.string() }),
			},
			operations: crudOperations.all(),
		});
		const adapter = new FakeCrudAdapter([{ id: 1, name: "Before" }]);
		const binding = defineCrudBinding({
			resource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => input,
				update: (input) => input,
				response: (record) => ({
					id: requiredNumber(record.id),
					name: requiredString(record.name),
				}),
			},
		});
		const scope: CrudScope<typeof resource> = {
			resolve: () => ({ updateValues: { tenantId: "tenant-a" } }),
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

		await expect(service.update({ id: 1 }, { name: "After" })).rejects.toMatchObject({
			status: 500,
		});
		expect(adapter.calls.update).toBe(0);
		expect(adapter.snapshot()).toEqual([{ id: 1, name: "Before" }]);
	});

	it("requires a persistence mapper for soft-delete bindings at construction", () => {
		const adapter = new FakeCrudAdapter();
		const binding = defineCrudBinding({
			resource: userResource,
			adapter: { useValue: adapter },
			mappings: {
				create: (input) => ({ name: input.name, tenantId: "tenant-a", deletedAt: null }),
				update: (input) => input,
				response: (record) => ({
					id: requiredNumber(record.id),
					name: requiredString(record.name),
					tenantId: requiredString(record.tenantId),
					deletedAt: null,
				}),
			},
		});

		expect(
			() =>
				new CrudService(
					userResource,
					binding,
					adapter,
					[],
					[],
					new CrudRegistry(),
					resolveCrudModuleOptions({}),
				),
		).toThrowError(/must define mappings\.persistence/u);
	});

	it("maps scoped and soft-delete logical values before every adapter write", async () => {
		const resource = defineCrudResource({
			name: "aliased-users",
			fields: ["id", "name", "tenantId", "deletedAt"],
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

const viewerBindingResource = defineCrudResource({
	fields: ["artifactId", "viewerUserId", "serverId", "alias", "toolPrefix", "visible"],
	name: "viewer-bindings",
	path: "viewer-bindings",
	itemPath: ":artifactId/:serverId",
	idFields: { artifactId: "artifactId", serverId: "serverId" },
	contracts: {
		id: z.object({ artifactId: z.string(), serverId: z.string() }),
		create: z.object({ toolPrefix: z.string() }),
		update: z.object({ toolPrefix: z.string().optional() }),
		upsert: z.object({ toolPrefix: z.string() }),
		response: z.object({
			artifactId: z.string(),
			viewerUserId: z.string(),
			serverId: z.string(),
			alias: z.string().nullable(),
			toolPrefix: z.string(),
		}),
	},
	operations: crudOperations.only("upsert"),
});

function createViewerBinding(
	adapter: FakeCrudAdapter,
	options: {
		readonly configure?: boolean;
		readonly map?: boolean;
		readonly conflictFields?: readonly [string, ...string[]];
		readonly overwriteFields?: readonly [string, ...string[]];
	} = {},
) {
	return defineCrudBinding({
		resource: viewerBindingResource,
		adapter: { useValue: adapter },
		scopeCreateFields: ["viewerUserId"],
		...(options.configure === false
			? {}
			: {
					upsert: {
						conflictFields: options.conflictFields ?? ["artifactId", "viewerUserId", "serverId"],
						overwriteFields: options.overwriteFields ?? ["alias", "toolPrefix"],
					},
				}),
		mappings: {
			create: (input) => ({
				artifactId: "unused",
				serverId: "unused",
				alias: null,
				toolPrefix: input.toolPrefix,
			}),
			...(options.map === false
				? {}
				: {
						upsert: (
							id: { artifactId: string; serverId: string },
							input: { toolPrefix: string },
						) => ({
							artifactId: id.artifactId,
							serverId: id.serverId,
							alias: null,
							toolPrefix: input.toolPrefix,
						}),
					}),
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				artifactId: requiredString(record.artifactId),
				viewerUserId: requiredString(record.viewerUserId),
				serverId: requiredString(record.serverId),
				alias: record.alias === null ? null : requiredString(record.alias),
				toolPrefix: requiredString(record.toolPrefix),
			}),
		},
	});
}

function viewerBindingScope(): CrudScope<typeof viewerBindingResource> {
	return {
		resolve: () => ({ createValues: { viewerUserId: "viewer-1" } }),
	};
}

function createViewerBindingService(
	adapter: FakeCrudAdapter,
	hooks: readonly CrudLifecycleHook<typeof viewerBindingResource>[] = [],
	scopes: readonly CrudScope<typeof viewerBindingResource>[] = [],
	validators: readonly CrudMutationValidator<typeof viewerBindingResource>[] = [],
) {
	return new CrudService(
		viewerBindingResource,
		createViewerBinding(adapter),
		adapter,
		hooks,
		scopes,
		new CrudRegistry(),
		resolveCrudModuleOptions({}),
		undefined,
		[],
		validators,
	);
}

const nestedChildResource = defineCrudResource({
	fields: ["parentId", "id", "name"],
	name: "nested-children",
	path: "parents/:parentId/children",
	itemPath: ":id",
	idFields: { parentId: "parentId", id: "id" },
	pathParams: {
		contract: z.object({ parentId: z.coerce.number().int() }),
		fields: { parentId: "parentId" },
	},
	contracts: {
		id: z.object({ parentId: z.coerce.number().int(), id: z.coerce.number().int() }),
		create: z.object({ id: z.number().int(), name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ parentId: z.number().int(), id: z.number().int(), name: z.string() }),
	},
	operations: crudOperations.only("create", "list", "read", "update"),
	query: {
		sort: { fields: ["id"], default: ["id"], cursor: ["id"] },
		pagination: { offset: true, cursor: true, defaultLimit: 1, maxLimit: 10 },
	},
});

function createNestedChildService(
	adapter: FakeCrudAdapter,
	scopes: readonly CrudScope<typeof nestedChildResource>[] = [],
	hooks: readonly CrudLifecycleHook<typeof nestedChildResource>[] = [],
) {
	const binding = defineCrudBinding({
		resource: nestedChildResource,
		adapter: { useValue: adapter },
		scopeCreateFields: ["parentId"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => nestedChildResponse(record),
		},
	});
	return new CrudService(
		nestedChildResource,
		binding,
		adapter,
		hooks,
		scopes,
		new CrudRegistry(),
		resolveCrudModuleOptions({}),
		new HmacSha256CrudCursorCodec("a secure cursor secret with at least thirty-two bytes"),
	);
}

function nestedChildResponse(record: Record<string, unknown>) {
	return {
		parentId: requiredNumber(record.parentId),
		id: requiredNumber(record.id),
		name: requiredString(record.name),
	};
}

const childResource = defineCrudResource({
	fields: ["id", "parentId", "name"],
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
	fields: ["id", "rank"],
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
	fields: ["id", "name"],
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
