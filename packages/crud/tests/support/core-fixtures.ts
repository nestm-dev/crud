import { z } from "zod";

import { defineCrudBinding } from "../../src/adapter/binding.types.ts";
import { resolveCrudModuleOptions } from "../../src/module/crud-module.options.ts";
import { defineCrudResource } from "../../src/resource/define-resource.ts";
import { crudOperations } from "../../src/resource/operations.ts";
import type {
	CrudLifecycleHook,
	CrudMutationValidator,
	CrudProjection,
	CrudScope,
} from "../../src/runtime/runtime.types.ts";
import { CrudRegistry } from "../../src/runtime/crud-registry.ts";
import { CrudService } from "../../src/runtime/crud.service.ts";
import { FakeCrudAdapter, type FakeRecord } from "./fake-crud-adapter.ts";

export const SOFT_DELETE_TIME = new Date("2026-08-01T12:00:00.000Z");

const childResponseSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	parentId: z.number().int(),
});

export const userResource = defineCrudResource({
	name: "users",
	path: "/api/users/",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int().positive() }),
		create: z.object({
			name: z.string().min(1),
			tenantId: z.string().optional(),
		}),
		update: z.object({ name: z.string().min(1).optional() }),
		response: z.object({
			id: z.number().int(),
			name: z.string(),
			tenantId: z.string(),
			deletedAt: z.date().nullable(),
			children: z.array(childResponseSchema).optional(),
		}),
	},
	operations: crudOperations.all({ restore: {} }),
	query: {
		filters: {
			name: { schema: z.string(), operators: ["eq", "icontains"] },
		},
		sort: { fields: ["id", "name"], default: ["id"] },
		search: { fields: ["name"] },
		pagination: { offset: true, defaultLimit: 10, maxLimit: 50 },
	},
	softDelete: {
		allowQueryDeleted: true,
		deleteValue: () => SOFT_DELETE_TIME,
		field: "deletedAt",
		restoreValue: () => null,
	},
	tags: ["User administration"],
});

export function createUserBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: userResource,
		adapter: { useValue: adapter },
		fields: ["id", "name", "tenantId", "deletedAt"],
		mappings: {
			create: (input) => ({
				name: input.name,
				...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
				deletedAt: null,
			}),
			update: (input) => (input.name === undefined ? {} : { name: input.name }),
			persistence: (values) => values,
			response: (record, relations) => ({
				id: requiredNumber(record.id, "id"),
				name: requiredString(record.name, "name"),
				tenantId: requiredString(record.tenantId, "tenantId"),
				deletedAt: nullableDate(record.deletedAt, "deletedAt"),
				...(relations.children === undefined
					? {}
					: { children: [...readChildren(relations.children)] }),
			}),
		},
	});
}

export interface CreateUserServiceOptions {
	readonly adapter?: FakeCrudAdapter;
	readonly hooks?: readonly CrudLifecycleHook<typeof userResource>[];
	readonly scopes?: readonly CrudScope<typeof userResource>[];
	readonly validators?: readonly CrudMutationValidator<typeof userResource>[];
	readonly projections?: readonly CrudProjection<typeof userResource>[];
	readonly registry?: CrudRegistry;
	readonly afterCommitErrorHandler?: Parameters<
		typeof resolveCrudModuleOptions
	>[0]["afterCommitErrorHandler"];
}

export function createUserService(options: CreateUserServiceOptions = {}) {
	const adapter = options.adapter ?? new FakeCrudAdapter();
	const binding = createUserBinding(adapter);
	const registry = options.registry ?? new CrudRegistry();
	const resolved = resolveCrudModuleOptions(
		options.afterCommitErrorHandler === undefined
			? {}
			: { afterCommitErrorHandler: options.afterCommitErrorHandler },
	);
	const service = new CrudService(
		userResource,
		binding,
		adapter,
		options.hooks ?? [],
		options.scopes ?? [],
		registry,
		resolved,
		undefined,
		options.projections ?? [],
		options.validators ?? [],
	);
	return { adapter, binding, registry, service };
}

export const compositeResource = defineCrudResource({
	name: "memberships",
	path: "memberships",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenantId", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string(), id: z.coerce.number().int() }),
		create: z.object({ tenantId: z.string(), id: z.number().int(), role: z.string() }),
		update: z.object({ role: z.string().optional() }),
		response: z.object({ tenantId: z.string(), id: z.number().int(), role: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
});

export function createCompositeBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: compositeResource,
		adapter: { useValue: adapter },
		fields: ["tenantId", "id", "role"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				tenantId: requiredString(record.tenantId, "tenantId"),
				id: requiredNumber(record.id, "id"),
				role: requiredString(record.role, "role"),
			}),
		},
	});
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Fake record field "${field}" must be a string.`);
	}
	return value;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number") {
		throw new TypeError(`Fake record field "${field}" must be a number.`);
	}
	return value;
}

function nullableDate(value: unknown, field: string): Date | null {
	if (value === null) {
		return null;
	}
	if (!(value instanceof Date)) {
		throw new TypeError(`Fake record field "${field}" must be a Date or null.`);
	}
	return value;
}

function readChildren(value: unknown): z.input<typeof childResponseSchema>[] {
	if (!Array.isArray(value)) {
		throw new TypeError("Fake children relation must be an array.");
	}
	return value.map((item) => {
		if (!isFakeRecord(item)) {
			throw new TypeError("Fake child relation item must be an object.");
		}
		return {
			id: requiredNumber(item.id, "children.id"),
			name: requiredString(item.name, "children.name"),
			parentId: requiredNumber(item.parentId, "children.parentId"),
		};
	});
}

function isFakeRecord(value: unknown): value is FakeRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
