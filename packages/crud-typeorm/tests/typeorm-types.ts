import { crudOperations, defineCrudResource } from "@nestm/crud";
import type { CrudAdapter, CrudAdapterSession } from "@nestm/crud/adapter";
import { Brackets, type DeepPartial, type Repository } from "typeorm";
import type { IsolationLevel } from "typeorm/driver/types/IsolationLevel.js";
import { z } from "zod";

import {
	bindTypeOrmCrud,
	createTypeOrmCrudAdapter,
	createTypeOrmCrudReferenceChecker,
	type BindTypeOrmCrudOptions,
	TypeOrmCrudAdapter,
	TypeOrmCrudTransactionIsolationLevel,
	type TypeOrmCrudAdapterOptions,
	type TypeOrmCrudSelectedRecord,
} from "../src/index.ts";

const nativeIsolationLevel: IsolationLevel = TypeOrmCrudTransactionIsolationLevel.RepeatableRead;
const configuredIsolationLevel: TypeOrmCrudTransactionIsolationLevel = "READ COMMITTED";
// @ts-expect-error The CRUD lifecycle deliberately supports only its documented subset.
const unsupportedIsolationLevel: TypeOrmCrudTransactionIsolationLevel = "SERIALIZABLE";
void nativeIsolationLevel;
void configuredIsolationLevel;
void unsupportedIsolationLevel;

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
void referenceChecker.exists(
	{
		predicate: {
			kind: "comparison",
			// @ts-expect-error reference predicates use the checker's exact logical columns.
			field: "name",
			operator: "eq",
			value: "Ada",
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
	transaction: { isolationLevel: TypeOrmCrudTransactionIsolationLevel.RepeatableRead },
});

void adapter.findMany(
	{
		order: [
			{
				// @ts-expect-error query fields are inferred from the adapter's logical columns.
				field: "email",
				direction: "asc",
			},
		],
		limit: 10,
		count: false,
	},
	{ resource: "users", operation: "list" },
);

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

export const inlineSelectedAdapter = createTypeOrmCrudAdapter({
	repository,
	columns: {
		id: true,
		name: true,
		tenantId: true,
		secret: { select: false },
		profileNickname: { property: "profile.nickname", select: true },
	},
});
type InlineSelectedRecord = Exclude<
	Awaited<ReturnType<typeof inlineSelectedAdapter.findOne>>,
	null
>;
declare const inlineSelectedRecord: InlineSelectedRecord;
const inlineName: string = inlineSelectedRecord.name;
const inlineNickname: string | undefined = inlineSelectedRecord.profile?.nickname;
// @ts-expect-error select:false fields are absent from the hydrated record type.
void inlineSelectedRecord.secret;
void inlineName;
void inlineNickname;

export const wildcardAdapter = createTypeOrmCrudAdapter({
	repository,
	columns: { "*": true },
	exclude: ["secret"],
});
type WildcardRecord = Exclude<Awaited<ReturnType<typeof wildcardAdapter.findOne>>, null>;
declare const wildcardRecord: WildcardRecord;
const wildcardName: string = wildcardRecord.name;
// @ts-expect-error Excluded wildcard properties are absent from the hydrated record type.
void wildcardRecord.secret;
void wildcardName;

createTypeOrmCrudAdapter({
	repository,
	columns: {
		id: true,
		// @ts-expect-error Column property paths are checked against the entity.
		name: { property: "display_name" },
	},
});

createTypeOrmCrudAdapter({
	repository,
	columns: {
		// @ts-expect-error Same-name shorthand rejects misspelled entity properties.
		displayName: true,
	},
});

createTypeOrmCrudAdapter({
	repository,
	columns: { "*": true },
	// @ts-expect-error Exclusions autocomplete and reject unknown entity paths.
	exclude: ["password"],
});

createTypeOrmCrudAdapter({
	repository,
	columns: { id: "id" },
	transaction: {
		// @ts-expect-error TypeORM isolation values use their native uppercase spelling.
		isolationLevel: "repeatable read",
	},
});

createTypeOrmCrudAdapter({
	repository,
	columns: { id: "id" },
	// @ts-expect-error The runner belongs inside the transaction object.
	transactionRunner: { run: (_context: unknown, work: never) => work },
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
	DeepPartial<UserEntity>,
	keyof UserEntity,
	"id" | "name" | "tenantId" | "secret"
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
	fields: ["id", "name", "tenantId"],
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
	fields: ["id", "name"],
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

const selectedBinding = bindTypeOrmCrud({
	resource,
	adapter: { useValue: selectedAdapter },
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
	mappings: {
		create: (input) => ({ name: input.name, tenantId: "tenant" }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: (values) =>
			typeof values.tenantId === "string" ? { tenantId: values.tenantId } : {},
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const invalidOptions: BindTypeOrmCrudOptions<typeof resource, UserEntity> = {
	resource,
	adapter: { useValue: adapter },
	mappings: {
		// @ts-expect-error binder mappings must return DeepPartial<Entity> values.
		create: () => ({ name: 123 }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
};

/**
 * Declaring same-name scope-owned insert fields maps them automatically, so an insert-only
 * column never has to be expressible in `mappings.persistence` — the update path shares
 * that mapper, and a field expressible there is a field a client can change.
 *
 * Unlike the Drizzle binder, this does NOT make create fields optional: TypeORM create
 * values are `DeepPartial<Entity>`, so every property is already optional and there is
 * nothing left to relax. The enforcement that a declared scope field is actually present
 * at insert time is the runtime assertion in CRUD's service, not the type.
 */
const scopedBinding = bindTypeOrmCrud({
	resource,
	adapter: { useValue: adapter },
	scopeCreateFields: ["tenantId"],
	mappings: {
		create: (input) => ({ name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const upsertBinding = bindTypeOrmCrud({
	resource: upsertResource,
	adapter: { useValue: adapter },
	scopeCreateFields: ["tenantId"],
	upsert: {
		conflictFields: ["id"],
		overwriteFields: ["name"],
	},
	mappings: {
		create: (input) => ({ name: input.name }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		upsert: (id, input) => ({ id: id.id, name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const invalidLogicalFieldResource = defineCrudResource({
	...resource,
	fields: ["id", "name", "tenantId", "email"],
	name: "invalid-logical-field-resource",
	path: "invalid-logical-field-resource",
});

// @ts-expect-error every resource field must exist in the adapter's logical column vocabulary.
const invalidLogicalFieldBinding = bindTypeOrmCrud({
	resource: invalidLogicalFieldResource,
	adapter: { useValue: adapter },
	mappings: {
		create: (input) => ({ name: input.name, tenantId: "tenant" }),
		update: (input) => (input.name === undefined ? {} : { name: input.name }),
		persistence: () => ({}),
		response: (record) => ({ id: record.id, name: record.name }),
	},
});

const invalidUpsertPersistenceFieldBinding = bindTypeOrmCrud({
	resource: upsertResource,
	adapter: { useValue: adapter },
	upsert: {
		conflictFields: [
			// @ts-expect-error conflict fields must be TypeORM entity property paths.
			"workspaceId",
		],
		overwriteFields: ["name"],
	},
	mappings: upsertBinding.mappings,
});

type InvalidScopeCreateField = BindTypeOrmCrudOptions<
	typeof resource,
	UserEntity,
	// @ts-expect-error scope-owned fields must be properties of the entity's create values.
	readonly ["notAColumn"]
>;

void binding;
void selectedBinding;
void invalidOptions;
void scopedBinding;
void upsertBinding;
void invalidLogicalFieldBinding;
void invalidUpsertPersistenceFieldBinding;
declare const invalidScopeCreateField: InvalidScopeCreateField;
void invalidScopeCreateField;
