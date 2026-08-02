import type { CrudAdapter } from "@nestm/crud/adapter";
import { defineCrudResource, crudOperations } from "@nestm/crud";
import { z } from "zod";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { bindDrizzleCrud, createDrizzleCrudAdapter } from "../src/index.ts";

const users = pgTable("users", {
	id: integer().primaryKey(),
	name: text().notNull(),
});

declare const database: NodePgDatabase<{ users: typeof users }>;

// Compile-only proof that a normal consumer-owned node-postgres Drizzle database is accepted.
export const adapter = createDrizzleCrudAdapter({
	database,
	table: users,
	columns: { id: users.id, name: users.name },
});

const nativeAdapter: CrudAdapter<
	InferSelectModel<typeof users>,
	InferInsertModel<typeof users>,
	Partial<InferInsertModel<typeof users>>
> = adapter;
void nativeAdapter;

void adapter.create({ values: { id: 1, name: "Ada" } }, { resource: "users", operation: "create" });
void adapter.update(
	{
		predicate: { kind: "comparison", field: "id", operator: "eq", value: 1 },
		values: { name: "Grace" },
	},
	{ resource: "users", operation: "update" },
);
void adapter.create(
	{
		// @ts-expect-error Drizzle's inferred insert model requires a string name.
		values: { id: 1, name: 123 },
	},
	{ resource: "users", operation: "create" },
);

const resource = defineCrudResource({
	name: "drizzle-users",
	path: "drizzle-users",
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

export const binding = bindDrizzleCrud({
	resource,
	adapter: { useValue: adapter },
	fields: ["id", "name"],
	mappings: {
		create: (input) => ({ id: 1, name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => record,
	},
});

export const invalidBinding = bindDrizzleCrud({
	resource,
	adapter: { useValue: adapter },
	fields: ["id", "name"],
	mappings: {
		// @ts-expect-error binder mappings must return the table's inferred insert model.
		create: () => ({ id: 1, name: 123 }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => record,
	},
});
