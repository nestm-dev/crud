import { crudOperations, defineCrudResource } from "@nestm/crud";
import type { CrudAdapter } from "@nestm/crud/adapter";
import { z } from "zod";

import {
	bindPrismaCrud,
	createPrismaCrudAdapter,
	type PrismaCrudCreateValues,
	type PrismaCrudUpdateValues,
} from "../src/index.ts";

interface UserRecord {
	readonly id: number;
	readonly name: string;
	readonly tenantId: string;
}

interface UserCreateValues {
	readonly name: string;
	readonly tenantId: string;
}

interface UserUpdateValues {
	readonly name?: string | { readonly set: string };
	readonly tenantId?: string | { readonly set: string };
}

interface UserWhereUnique {
	readonly id?: number;
	readonly tenantId_name?: {
		readonly tenantId: string;
		readonly name: string;
	};
}

interface UserDelegate {
	create<Arguments extends { readonly data: UserCreateValues }>(
		arguments_: Arguments,
	): PromiseLike<UserRecord>;
	update<Arguments extends { readonly where: UserWhereUnique; readonly data: UserUpdateValues }>(
		arguments_: Arguments,
	): PromiseLike<UserRecord>;
}

interface Client {
	readonly user: UserDelegate;
	$transaction<Result>(work: (transaction: Client) => Promise<Result>): Promise<Result>;
}

declare const client: Client;

export type DelegateCreateInference = Assert<
	Equal<PrismaCrudCreateValues<UserDelegate>, UserCreateValues>
>;
export type DelegateUpdateInference = Assert<
	Equal<PrismaCrudUpdateValues<UserDelegate>, UserUpdateValues>
>;

export const adapter = createPrismaCrudAdapter<UserRecord, Client, UserDelegate>({
	client,
	delegate: (owner) => owner.user,
	identity: (record) => ({ id: record.id }),
});

createPrismaCrudAdapter<UserRecord, Client, UserDelegate>({
	client,
	delegate: (owner) => owner.user,
	identity: (record) => ({ id: record.id }),
	fields: {
		// @ts-expect-error Prisma field mappings must target model fields.
		displayName: "email",
	},
});

createPrismaCrudAdapter<UserRecord, Client, UserDelegate>({
	client,
	delegate: (owner) => owner.user,
	identity: (record) => ({ id: record.id }),
	fields: { displayName: "name" },
	recordKeys: {
		// @ts-expect-error record key mappings must target returned-record keys.
		displayName: "displayName",
	},
});

createPrismaCrudAdapter<UserRecord, Client, UserDelegate>({
	client,
	delegate: (owner) => owner.user,
	// @ts-expect-error identity must return the delegate's native unique selector.
	identity: () => ({ email: "ada@example.com" }),
});

const nativeAdapter: CrudAdapter<
	UserRecord,
	UserCreateValues,
	UserUpdateValues,
	keyof UserCreateValues,
	keyof UserRecord
> = adapter;
void nativeAdapter;

void adapter.create(
	{ values: { name: "Ada", tenantId: "tenant" } },
	{ resource: "users", operation: "create" },
);
void adapter.findMany(
	{
		predicate: {
			kind: "comparison",
			// @ts-expect-error query fields are inferred from the Prisma record shape.
			field: "email",
			operator: "eq",
			value: "ada@example.com",
		},
		order: [],
		limit: 10,
		count: false,
	},
	{ resource: "users", operation: "list" },
);
void adapter.create(
	{
		// @ts-expect-error Prisma delegate create data requires a string name.
		values: { name: 123, tenantId: "tenant" },
	},
	{ resource: "users", operation: "create" },
);

const resource = defineCrudResource({
	fields: ["id", "name", "tenantId"],
	name: "prisma-users",
	path: "prisma-users",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number().int(), name: z.string() }),
	},
	operations: crudOperations.all(),
});

export const binding = bindPrismaCrud({
	resource,
	adapter: { useValue: adapter },
	mappings: {
		create: (input) => ({ name: input.name, tenantId: "tenant" }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: (values) =>
			typeof values.tenantId === "string" ? { tenantId: values.tenantId } : {},
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

export const invalidBinding = bindPrismaCrud({
	resource,
	adapter: { useValue: adapter },
	mappings: {
		// @ts-expect-error binder mappings must return the delegate's create data type.
		create: () => ({ name: 123, tenantId: "tenant" }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const invalidLogicalFieldResource = defineCrudResource({
	...resource,
	fields: ["id", "name", "tenantId", "email"],
	name: "invalid-prisma-logical-field",
	path: "invalid-prisma-logical-field",
});

// @ts-expect-error every resource field must exist in the adapter's logical field map.
bindPrismaCrud({
	resource: invalidLogicalFieldResource,
	adapter: { useValue: adapter },
	mappings: {
		create: (input) => ({ name: input.name, tenantId: "tenant" }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;

type Assert<Value extends true> = Value;
