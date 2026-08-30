import type { CrudAdapter } from "@nestm/crud/adapter";
import { CrudModule, defineCrudResource, crudOperations } from "@nestm/crud";
import { z } from "zod";
import { eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { bindDrizzleCrud, createDrizzleCrudAdapter } from "../src/index.ts";

const users = pgTable("users", {
	id: integer().primaryKey(),
	name: text().notNull(),
});

const scopedUsers = pgTable("scoped_users", {
	id: integer().primaryKey(),
	tenantId: text().notNull(),
	ownerId: text().notNull(),
	name: text().notNull(),
});

declare const database: NodePgDatabase<{ users: typeof users }>;

// Compile-only proof that a normal consumer-owned node-postgres Drizzle database is accepted.
export const adapter = createDrizzleCrudAdapter({
	database,
	table: users,
	columns: { id: users.id, name: users.name },
	transaction: { isolationLevel: "repeatable read" },
});

createDrizzleCrudAdapter({
	database,
	table: users,
	columns: {
		// @ts-expect-error mapped columns must belong to the configured table.
		ownerId: scopedUsers.ownerId,
	},
});

createDrizzleCrudAdapter({
	database,
	table: users,
	columns: { id: users.id, name: users.name },
	recordKeys: {
		// @ts-expect-error returned-row keys are inferred from the table select model.
		id: "userId",
	},
});

// Compile-only proof that application-owned transactions and native row predicates stay typed.
export const securedAdapter = createDrizzleCrudAdapter({
	database,
	table: users,
	columns: { id: users.id, name: users.name },
	transactionRunner: {
		run: (_context, workWithTransaction) => workWithTransaction(database),
	},
	rowPredicate: ({ table, context }) => {
		void context.executionContext;
		return eq(table.id, 1);
	},
});

// Runners can report strengthened effective settings, and predicates can request
// their minimum isolation level before the transaction is opened.
export const snapshotSecuredAdapter = createDrizzleCrudAdapter({
	database,
	table: users,
	columns: { id: users.id, name: users.name },
	transactionRunner: {
		run: (context, workWithTransaction) =>
			workWithTransaction(database, {
				accessMode: context.accessMode,
				isolationLevel: "repeatable read",
				ownsCommit: context.mustOwnCommit,
			}),
	},
	rowPredicate: {
		resolve: ({ table }) => eq(table.id, 1),
		transaction: { isolationLevel: "repeatable read" },
	},
});

const nativeAdapter: CrudAdapter<
	InferSelectModel<typeof users>,
	InferInsertModel<typeof users>,
	Partial<InferInsertModel<typeof users>>,
	keyof InferInsertModel<typeof users>,
	"id" | "name"
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
void adapter.findMany(
	{
		order: [
			{
				// @ts-expect-error query fields are inferred from the configured logical columns.
				field: "email",
				direction: "asc",
			},
		],
		limit: 10,
		count: false,
	},
	{ resource: "users", operation: "list" },
);
void adapter.create(
	{
		// @ts-expect-error Drizzle's inferred insert model requires a string name.
		values: { id: 1, name: 123 },
	},
	{ resource: "users", operation: "create" },
);

const resource = defineCrudResource({
	fields: ["id", "name"],
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
	mappings: {
		// @ts-expect-error binder mappings must return the table's inferred insert model.
		create: () => ({ id: 1, name: 123 }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => record,
	},
});

const invalidLogicalFieldResource = defineCrudResource({
	...resource,
	fields: ["id", "name", "email"],
	name: "invalid-drizzle-logical-field",
	path: "invalid-drizzle-logical-field",
});

// @ts-expect-error every resource field must exist in the adapter's logical column map.
bindDrizzleCrud({
	resource: invalidLogicalFieldResource,
	adapter: { useValue: adapter },
	mappings: {
		create: (input) => ({ id: 1, name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => record,
	},
});

const scopedAdapter = createDrizzleCrudAdapter({
	database,
	table: scopedUsers,
	columns: {
		id: scopedUsers.id,
		tenantId: scopedUsers.tenantId,
		ownerId: scopedUsers.ownerId,
		name: scopedUsers.name,
	},
});

const scopedResource = defineCrudResource({
	fields: ["id", "tenantId", "ownerId", "name"],
	name: "scoped-drizzle-users",
	path: "scoped-drizzle-users",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: resource.contracts,
	operations: crudOperations.all(),
});

// Scope-owned insert fields can be omitted by the API create mapper because persistence
// supplies them after scope resolution and overwrites any mapper-provided values.
export const scopedBinding = bindDrizzleCrud({
	resource: scopedResource,
	adapter: { useValue: scopedAdapter },
	scopeCreateFields: ["tenantId", "ownerId"],
	mappings: {
		create: (input) => ({ id: 1, name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: (values) => ({
			...(typeof values.tenantId === "string" ? { tenantId: values.tenantId } : {}),
			...(typeof values.ownerId === "string" ? { ownerId: values.ownerId } : {}),
		}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

// Scoped bindings remain accepted by the normal feature-module entry point.
CrudModule.forFeature({ resources: [scopedBinding] });

export const missingRequiredUnscopedField = bindDrizzleCrud({
	resource: scopedResource,
	adapter: { useValue: scopedAdapter },
	mappings: {
		// @ts-expect-error unscoped create mappings still require every required insert field.
		create: (input) => ({ id: 1, name: input.name }),
		update: () => ({}),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

export const missingRequiredNonScopeField = bindDrizzleCrud({
	resource: scopedResource,
	adapter: { useValue: scopedAdapter },
	scopeCreateFields: ["tenantId", "ownerId"],
	mappings: {
		// @ts-expect-error only declared scope fields become optional for the create mapper.
		create: () => ({ id: 1 }),
		update: () => ({}),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

export const invalidScopeCreateField = bindDrizzleCrud({
	resource: scopedResource,
	adapter: { useValue: scopedAdapter },
	// @ts-expect-error scope-owned fields must be keys accepted by create and persistence mappings.
	scopeCreateFields: ["notAColumn"],
	mappings: {
		create: () => ({ id: 1, tenantId: "tenant", ownerId: "owner", name: "Ada" }),
		update: () => ({}),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});
