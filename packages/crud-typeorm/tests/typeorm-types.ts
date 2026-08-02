import { crudOperations, defineCrudResource } from "@nestm/crud";
import type { CrudAdapter } from "@nestm/crud/adapter";
import type { DeepPartial, Repository } from "typeorm";
import { z } from "zod";

import {
	bindTypeOrmCrud,
	createTypeOrmCrudAdapter,
	type BindTypeOrmCrudOptions,
} from "../src/index.ts";

interface UserEntity {
	readonly id: number;
	name: string;
	tenantId: string;
}

declare const repository: Repository<UserEntity>;

export const adapter = createTypeOrmCrudAdapter({
	repository,
	columns: { id: "id", name: "name", tenantId: "tenantId" },
});

const nativeAdapter: CrudAdapter<
	UserEntity,
	DeepPartial<UserEntity>,
	DeepPartial<UserEntity>
> = adapter;
void nativeAdapter;

void adapter.create(
	{ values: { name: "Ada", tenantId: "tenant" } },
	{ resource: "users", operation: "create" },
);
void adapter.create(
	{
		// @ts-expect-error TypeORM create values use DeepPartial<Entity> property types.
		values: { name: 123 },
	},
	{ resource: "users", operation: "create" },
);

const resource = defineCrudResource({
	name: "typeorm-users",
	path: "typeorm-users",
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

const fields = ["id", "name", "tenantId"] as const;

const binding = bindTypeOrmCrud({
	resource,
	adapter: { useValue: adapter },
	fields,
	mappings: {
		create: (input) => ({ name: input.name, tenantId: "tenant" }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: (values) =>
			typeof values.tenantId === "string" ? { tenantId: values.tenantId } : {},
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const invalidOptions: BindTypeOrmCrudOptions<typeof resource, UserEntity, typeof fields> = {
	resource,
	adapter: { useValue: adapter },
	fields,
	mappings: {
		// @ts-expect-error binder mappings must return DeepPartial<Entity> values.
		create: () => ({ name: 123 }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
};

void binding;
void invalidOptions;
