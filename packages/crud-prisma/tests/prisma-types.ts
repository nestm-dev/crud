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

interface UserDelegate {
	create<Arguments extends { readonly data: UserCreateValues }>(
		arguments_: Arguments,
	): PromiseLike<UserRecord>;
	update<Arguments extends { readonly where: object; readonly data: UserUpdateValues }>(
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

const nativeAdapter: CrudAdapter<UserRecord, UserCreateValues, UserUpdateValues> = adapter;
void nativeAdapter;

void adapter.create(
	{ values: { name: "Ada", tenantId: "tenant" } },
	{ resource: "users", operation: "create" },
);
void adapter.create(
	{
		// @ts-expect-error Prisma delegate create data requires a string name.
		values: { name: 123, tenantId: "tenant" },
	},
	{ resource: "users", operation: "create" },
);

const resource = defineCrudResource({
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
	fields: ["id", "name", "tenantId"],
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
	fields: ["id", "name", "tenantId"],
	mappings: {
		// @ts-expect-error binder mappings must return the delegate's create data type.
		create: () => ({ name: 123, tenantId: "tenant" }),
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
