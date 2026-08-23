import { crudOperations, defineCrudResource } from "@nestm/crud";
import type { CrudAdapter, CrudAdapterSession } from "@nestm/crud/adapter";
import { Brackets, type DeepPartial, type Repository } from "typeorm";
import { z } from "zod";

import {
	bindTypeOrmCrud,
	createTypeOrmCrudAdapter,
	createTypeOrmCrudReferenceChecker,
	type BindTypeOrmCrudOptions,
	TypeOrmCrudAdapter,
	type TypeOrmCrudAdapterOptions,
	type TypeOrmCrudSelectedRecord,
} from "../src/index.ts";

class UserProfile {
	readonly nickname!: string;
}

interface UserEntity {
	readonly id: number;
	name: string;
	tenantId: string;
	secret: string;
	profile: UserProfile | null;
	optionalLabel?: string;
}

declare const repository: Repository<UserEntity>;

const referenceChecker = createTypeOrmCrudReferenceChecker({
	target: repository.target,
	columns: { id: "id", tenantId: "tenantId" },
});
declare const session: CrudAdapterSession;
const typedValidationContext = { session, facts: { tenantId: "tenant-a" } } as const;
void referenceChecker.exists(
	{
		predicate: { kind: "comparison", field: "id", operator: "eq", value: 1 },
		nativePredicate: ({ alias, context }) => {
			const tenantId: string = context.facts.tenantId;
			return new Brackets((where) => where.where(`${alias}.tenantId = :tenantId`, { tenantId }));
		},
	},
	typedValidationContext,
);
// @ts-expect-error Reference checks cannot be invoked without an active session.
void referenceChecker.exists({ predicate: { kind: "and", predicates: [] } }, {});
// @ts-expect-error Reference checks must always declare an explicit scoped predicate.
void referenceChecker.exists({}, { session });

export const adapter = createTypeOrmCrudAdapter({
	repository,
	columns: { id: "id", name: "name", tenantId: "tenantId", secret: "secret" },
	transaction: { isolationLevel: "repeatable read" },
});

export const selectedAdapter = createTypeOrmCrudAdapter({
	repository,
	columns: { id: "id", name: "name", tenantId: "tenantId", secret: "secret" },
	select: {
		id: true,
		name: true,
		profile: { nickname: true },
		optionalLabel: true,
	},
});

const selection = {
	id: true,
	name: true,
	profile: { nickname: true },
	optionalLabel: true,
} as const;
type SelectedUser = TypeOrmCrudSelectedRecord<UserEntity, typeof selection>;
declare const selectedUser: SelectedUser;
const selectedNickname: string | undefined = selectedUser.profile?.nickname;
const selectedOptionalLabel: string | undefined = selectedUser.optionalLabel;
// @ts-expect-error Selected records preserve readonly entity fields.
selectedUser.id = 2;
void selectedNickname;
void selectedOptionalLabel;

declare const conditionalSelection: { readonly id: true; readonly name?: true };
const conditionalAdapter = createTypeOrmCrudAdapter({
	repository,
	columns: { id: "id", name: "name" },
	select: conditionalSelection,
});
type ConditionalRecord = Exclude<Awaited<ReturnType<typeof conditionalAdapter.findOne>>, null>;
declare const conditionalRecord: ConditionalRecord;
const maybeSelectedName: string | undefined = conditionalRecord.name;
// @ts-expect-error A conditionally selected field is not definitely hydrated.
const definitelySelectedName: string = conditionalRecord.name;
void maybeSelectedName;
void definitelySelectedName;

// The public class constructor is full-entity only; selected construction goes through
// the factory so its narrowed output type cannot be accidentally omitted.
// @ts-expect-error Direct construction cannot accept a selected record configuration.
new TypeOrmCrudAdapter({ repository, columns: { id: "id" }, select: { id: true } });

declare const widenedOptions: TypeOrmCrudAdapterOptions<UserEntity>;
const widenedAdapter: CrudAdapter<
	DeepPartial<UserEntity>,
	DeepPartial<UserEntity>,
	DeepPartial<UserEntity>
> = createTypeOrmCrudAdapter(widenedOptions);
void widenedAdapter;

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

void selectedAdapter.create(
	{ values: { name: "Ada", tenantId: "tenant", secret: "encrypted" } },
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

const upsertResource = defineCrudResource({
	name: "typeorm-user-upserts",
	path: "typeorm-user-upserts",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		upsert: z.object({ name: z.string() }),
		response: z.object({ id: z.number().int(), name: z.string() }),
	},
	operations: crudOperations.only("upsert"),
});

const fields = ["id", "name", "tenantId"] as const;

const selectedBinding = bindTypeOrmCrud({
	resource,
	adapter: { useValue: selectedAdapter },
	fields: ["id", "name"],
	mappings: {
		create: (input) => ({ name: input.name, tenantId: "tenant", secret: "encrypted" }),
		update: (input) => input,
		response: (record) => {
			void record.id;
			void record.name;
			// @ts-expect-error Unselected entity fields are absent from the hydrated record type.
			void record.secret;
			return { id: record.id, name: record.name };
		},
	},
});

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

/**
 * Declaring scope-owned insert fields routes them through `mappings.scopeCreate`, so an
 * insert-only column never has to be expressible in `mappings.persistence` — the update
 * path shares that mapper, and a field expressible there is a field a client can change.
 *
 * Unlike the Drizzle binder, this does NOT make create fields optional: TypeORM create
 * values are `DeepPartial<Entity>`, so every property is already optional and there is
 * nothing left to relax. The enforcement that a declared scope field is actually present
 * at insert time is the runtime assertion in CRUD's service, not the type.
 */
const scopedBinding = bindTypeOrmCrud({
	resource,
	adapter: { useValue: adapter },
	fields,
	scopeCreateFields: ["tenantId"],
	mappings: {
		create: (input) => ({ name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		scopeCreate: (values) => ({ tenantId: values.tenantId as string }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const upsertBinding = bindTypeOrmCrud({
	resource: upsertResource,
	adapter: { useValue: adapter },
	fields,
	scopeCreateFields: ["tenantId"],
	upsert: {
		conflictFields: ["id"],
		overwriteFields: ["name"],
	},
	mappings: {
		create: (input) => ({ name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		upsert: (id, input) => ({ id: id.id, name: input.name }),
		scopeCreate: (values) => ({ tenantId: values.tenantId as string }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

type InvalidScopeCreateField = BindTypeOrmCrudOptions<
	typeof resource,
	UserEntity,
	typeof fields,
	// @ts-expect-error scope-owned fields must be properties of the entity's create values.
	readonly ["notAColumn"]
>;

void binding;
void selectedBinding;
void invalidOptions;
void scopedBinding;
void upsertBinding;
declare const invalidScopeCreateField: InvalidScopeCreateField;
void invalidScopeCreateField;
