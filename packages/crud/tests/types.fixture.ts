import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExecutionContext } from "@nestjs/common";

import type { CrudAdapter } from "../src/adapter/adapter.types.ts";
import { defineCrudBinding, type CrudResourceBinding } from "../src/adapter/binding.types.ts";
import { defineCrudFactoryProvider } from "../src/module/factory-provider.types.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations, type CrudOperations } from "../src/resource/operations.ts";
import { CrudModule, type CrudModuleAsyncOptions } from "../src/module/crud.module.ts";
import { getCrudServiceToken, type CrudServiceToken } from "../src/module/crud.tokens.ts";
import type {
	AnyCrudResource,
	CrudCreate,
	CrudId,
	CrudPathParams,
	CrudResponse,
	CrudUpdate,
	CrudUpsert,
} from "../src/resource/resource.types.ts";
import type {
	CrudCollectionArgs,
	CrudLifecycleHook,
	CrudMutationValidator,
	CrudScope,
} from "../src/runtime/runtime.types.ts";
import { defineCrudFact, provideCrudFact } from "../src/runtime/crud-facts.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

export const typedResource = defineCrudResource({
	name: "typed-records",
	path: "typed-records",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenantId", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string(), id: z.coerce.number().int() }),
		create: z.object({ label: z.string(), count: z.coerce.number().int() }),
		update: z.object({ label: z.string().optional(), count: z.number().int().optional() }),
		response: z.object({
			tenantId: z.string(),
			id: z.number().int(),
			label: z.string(),
			count: z.number().int(),
		}),
	},
	operations: crudOperations.all(),
});

export const idempotentDeleteOperations: CrudOperations = {
	delete: { missing: "ignore" },
};
export const invalidReadMissingOperations: CrudOperations = {
	// @ts-expect-error missing-row behavior is specific to delete operations.
	read: { missing: "ignore" },
};

export type IdInference = Assert<
	Equal<CrudId<typeof typedResource>, { tenantId: string; id: number }>
>;
export type CreateInference = Assert<
	Equal<CrudCreate<typeof typedResource>, { label: string; count: number }>
>;
export type UpdateInference = Assert<
	Equal<
		CrudUpdate<typeof typedResource>,
		{ label?: string | undefined; count?: number | undefined }
	>
>;
export type ResponseInference = Assert<
	Equal<
		CrudResponse<typeof typedResource>,
		{ tenantId: string; id: number; label: string; count: number }
	>
>;
export type FlatPathParamsInference = Assert<Equal<CrudPathParams<typeof typedResource>, never>>;
export type ErasedPathParamsInference = Assert<
	Equal<CrudPathParams<AnyCrudResource>, Readonly<Record<string, unknown>>>
>;

export const nestedTypedResource = defineCrudResource({
	name: "typed-children",
	path: "parents/:parentId/children",
	itemPath: ":childId",
	idFields: { parentId: "parentId", childId: "childId" },
	pathParams: {
		contract: z.object({ parentId: z.string().uuid() }),
		fields: { parentId: "parentId" },
	},
	contracts: {
		id: z.object({ parentId: z.string().uuid(), childId: z.coerce.number().int() }),
		create: z.object({ label: z.string() }),
		update: z.object({ label: z.string().optional() }),
		upsert: z.object({ label: z.string(), enabled: z.boolean().default(true) }),
		response: z.object({ parentId: z.string().uuid(), childId: z.number(), label: z.string() }),
	},
	operations: crudOperations.only("create", "list", "read", "upsert"),
});

export type NestedPathParamsInference = Assert<
	Equal<CrudPathParams<typeof nestedTypedResource>, { parentId: string }>
>;
export type MixedPathParamsInference = Assert<
	Equal<
		CrudPathParams<typeof typedResource | typeof nestedTypedResource>,
		Readonly<Record<string, unknown>>
	>
>;
export type UpsertInference = Assert<
	Equal<CrudUpsert<typeof nestedTypedResource>, { label: string; enabled: boolean }>
>;
export type MissingUpsertInference = Assert<Equal<CrudUpsert<typeof typedResource>, never>>;
export type ErasedUpsertInference = Assert<Equal<CrudUpsert<AnyCrudResource>, never>>;
export type MixedUpsertInference = Assert<
	Equal<CrudUpsert<typeof typedResource | typeof nestedTypedResource>, unknown>
>;
type FlatCollectionArguments = readonly [executionContext?: ExecutionContext];
type ErasedNestedCollectionArguments = readonly [
	pathParams: Readonly<Record<string, unknown>>,
	executionContext?: ExecutionContext,
];
export type FlatCollectionArgsInference = Assert<
	Equal<CrudCollectionArgs<typeof typedResource>, FlatCollectionArguments>
>;
export type NestedCollectionArgsInference = Assert<
	Equal<
		CrudCollectionArgs<typeof nestedTypedResource>,
		readonly [pathParams: { parentId: string }, executionContext?: ExecutionContext]
	>
>;
export type ErasedCollectionArgsInference = Assert<
	Equal<
		CrudCollectionArgs<AnyCrudResource>,
		FlatCollectionArguments | ErasedNestedCollectionArguments
	>
>;
export type MixedCollectionArgsInference = Assert<
	Equal<
		CrudCollectionArgs<typeof typedResource | typeof nestedTypedResource>,
		FlatCollectionArguments | ErasedNestedCollectionArguments
	>
>;

export const typedHook: CrudLifecycleHook<typeof typedResource> = {
	beforeCreate: (input) => ({ ...input, count: input.count + 1 }),
	beforeUpdate: (input) => ({ ...input, label: input.label?.trim() }),
};

interface AuthorizedParent {
	readonly id: string;
	readonly organizationId: string | null;
}

export const authorizedParentFact = defineCrudFact<AuthorizedParent>("authorized-parent");
export const typedFactEntry = provideCrudFact(authorizedParentFact, {
	id: "parent-1",
	organizationId: null,
});
// @ts-expect-error fact entries reject values unrelated to their declared fact type.
export const invalidTypedFactEntry = provideCrudFact(authorizedParentFact, { id: 123 });

export const typedScope: CrudScope<typeof typedResource> = {
	resolve: (context) => ({
		createValues: { tenantId: context.resource.name },
		predicate: {
			kind: "comparison",
			field: "tenantId",
			operator: "eq",
			value: context.resource.name,
		},
		facts: [typedFactEntry],
	}),
};

export const typedValidator: CrudMutationValidator<typeof typedResource> = {
	validateCreate: (input, context) => {
		const parent: AuthorizedParent = context.facts.require(authorizedParentFact);
		const session = context.session;
		void [input.count, parent.organizationId, session];
	},
	validateUpdate: (id, input, context) => {
		void [id.id, input.count, context.operation];
		// @ts-expect-error validators never expose the potentially stale pre-mutation snapshot.
		void context.prior;
	},
	validateDelete: (id, context) => {
		void [id.tenantId, context.operation];
	},
};

export const typedBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: new FakeCrudAdapter() },
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		create: (input) => input,
		update: (input) => input,
		persistence: (values) => values,
		response: () => ({ tenantId: "tenant", id: 1, label: "typed", count: 1 }),
	},
});

interface NativeRecord {
	readonly tenant_id: string;
	readonly record_id: number;
	readonly display_label: string;
	readonly total_count: number;
	readonly deleted_at: Date | null;
}

interface NativeCreateValues {
	readonly tenant_id: string;
	readonly display_label: string;
	readonly total_count: number;
}

interface NativeUpdateValues {
	readonly tenant_id?: string;
	readonly display_label?: string;
	readonly total_count?: number;
	readonly deleted_at?: Date | null;
}

declare const nativeAdapter: CrudAdapter<NativeRecord, NativeCreateValues, NativeUpdateValues>;

interface ImmutableScopeRecord {
	readonly id: number;
	readonly owner_id: string;
	readonly display_label: string;
}

interface ImmutableScopeCreateValues {
	readonly owner_id: string;
	readonly display_label: string;
}

interface ImmutableScopeUpdateValues {
	readonly display_label?: string;
}

declare const immutableScopeAdapter: CrudAdapter<
	ImmutableScopeRecord,
	ImmutableScopeCreateValues,
	ImmutableScopeUpdateValues
>;

// Scope-owned fields may be immutable insert-only fields that the update model rejects.
export const immutableScopeBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: immutableScopeAdapter },
	fields: ["tenantId", "id", "label", "count"],
	scopeCreateFields: ["owner_id"],
	mappings: {
		create: (input) => ({ display_label: input.label }),
		scopeCreate: (values) =>
			typeof values.ownerId === "string" ? { owner_id: values.ownerId } : {},
		update: (input) => (input.label === undefined ? {} : { display_label: input.label }),
		persistence: () => ({}),
		response: (record) => ({
			tenantId: record.owner_id,
			id: record.id,
			label: record.display_label,
			count: 0,
		}),
	},
});

export const persistenceTypedBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: nativeAdapter },
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		create: (input) => ({
			tenant_id: "tenant",
			display_label: input.label,
			total_count: input.count,
		}),
		update: (input) => ({
			...(input.label === undefined ? {} : { display_label: input.label }),
			...(input.count === undefined ? {} : { total_count: input.count }),
		}),
		persistence: (values) =>
			typeof values.tenantId === "string" ? { tenant_id: values.tenantId } : {},
		response: (record) => ({
			tenantId: record.tenant_id,
			id: record.record_id,
			label: record.display_label,
			count: record.total_count,
		}),
	},
});

export type PersistenceCreateInference = Assert<
	Equal<BindingCreateValues<typeof persistenceTypedBinding>, NativeCreateValues>
>;
export type PersistenceUpdateInference = Assert<
	Equal<BindingUpdateValues<typeof persistenceTypedBinding>, NativeUpdateValues>
>;

export const invalidPersistenceCreateBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: nativeAdapter },
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		// @ts-expect-error mapped creates must contain every required native create value.
		create: (input) => ({ display_label: input.label, total_count: input.count }),
		update: () => ({}),
		persistence: () => ({}),
		response: (record) => ({
			tenantId: record.tenant_id,
			id: record.record_id,
			label: record.display_label,
			count: record.total_count,
		}),
	},
});

export const invalidPersistenceUpdateBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: nativeAdapter },
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		create: (input) => ({
			tenant_id: "tenant",
			display_label: input.label,
			total_count: input.count,
		}),
		// @ts-expect-error mapped updates must use the native update value types.
		update: () => ({ total_count: "wrong" }),
		persistence: () => ({}),
		response: (record) => ({
			tenantId: record.tenant_id,
			id: record.record_id,
			label: record.display_label,
			count: record.total_count,
		}),
	},
});

export const invalidFrameworkPersistenceBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: nativeAdapter },
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		create: (input) => ({
			tenant_id: "tenant",
			display_label: input.label,
			total_count: input.count,
		}),
		update: () => ({}),
		// @ts-expect-error scope and soft-delete mappings must use native update value types.
		persistence: () => ({ tenant_id: 123 }),
		response: (record) => ({
			tenantId: record.tenant_id,
			id: record.record_id,
			label: record.display_label,
			count: record.total_count,
		}),
	},
});

interface TypedAdapterDependency {
	readonly adapter: CrudAdapter<Record<string, unknown>>;
}

const adapterDependencyToken = Symbol("typed-adapter-dependency");
export const typedAdapterFactory = defineCrudFactoryProvider<
	CrudAdapter<Record<string, unknown>>,
	readonly [TypedAdapterDependency]
>({
	inject: [adapterDependencyToken] as const,
	useFactory: (dependency) => dependency.adapter,
});
export type AdapterFactoryDependencyInference = Assert<
	Equal<Parameters<typeof typedAdapterFactory.useFactory>[0], TypedAdapterDependency>
>;

export const factoryBackedBinding = defineCrudBinding({
	resource: typedResource,
	adapter: typedAdapterFactory,
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		create: (input) => input,
		update: (input) => input,
		persistence: (values) => values,
		response: () => ({ tenantId: "tenant", id: 1, label: "typed", count: 1 }),
	},
});

const configToken = Symbol("typed-config");
interface TypedRootConfig {
	readonly cursorSecret: string;
}
const typedAsyncOptions = {
	inject: [configToken],
	useFactory: (config) => ({
		cursor: { secret: config.cursorSecret },
	}),
} satisfies CrudModuleAsyncOptions<readonly [TypedRootConfig]>;
export const typedAsyncRoot = CrudModule.forRootAsync(typedAsyncOptions);
export const inferredAsyncRoot = CrudModule.forRootAsync({
	inject: [configToken],
	useFactory: (config: TypedRootConfig) => ({ cursor: { secret: config.cursorSecret } }),
});

const invalidAsyncOptions: CrudModuleAsyncOptions<readonly [TypedRootConfig]> = {
	// @ts-expect-error the injection-token tuple must match the factory parameter tuple length.
	inject: [configToken, configToken],
	useFactory: (config) => ({ cursor: { secret: config.cursorSecret } }),
};
void invalidAsyncOptions;

export const typedServiceToken = getCrudServiceToken(typedResource);
export type ServiceTokenResourceInference = Assert<
	Equal<ServiceTokenResource<typeof typedServiceToken>, typeof typedResource>
>;

// @ts-expect-error the ID contract must output a keyed parameter object.
const scalarIdResource = defineCrudResource({
	...typedResource,
	name: "scalar-id",
	path: "scalar-id",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: { ...typedResource.contracts, id: z.coerce.number().int() },
});

// @ts-expect-error every ID-schema output key must have a matching idFields entry.
const missingIdFieldResource = defineCrudResource({
	...typedResource,
	name: "missing-id-field",
	path: "missing-id-field",
	itemPath: ":id",
	idFields: { id: "id" },
});

// @ts-expect-error itemPath parameters must exactly match the ID-schema and idFields keys.
const mismatchedItemPathResource = defineCrudResource({
	...typedResource,
	name: "mismatched-item-path",
	path: "mismatched-item-path",
	itemPath: ":tenantId/:recordId",
});

// @ts-expect-error every route parameter must be required in the ID-schema output.
const optionalIdResource = defineCrudResource({
	...typedResource,
	name: "optional-id",
	path: "optional-id",
	contracts: {
		...typedResource.contracts,
		id: z.object({ tenantId: z.string(), id: z.number().optional() }),
	},
});

void scalarIdResource;
void missingIdFieldResource;
void mismatchedItemPathResource;
void optionalIdResource;

declare const unknownIdSchema: StandardSchemaV1<unknown, unknown>;

// @ts-expect-error literal resources require a statically known ID-schema output.
const unknownIdResource = defineCrudResource({
	...typedResource,
	name: "unknown-id",
	path: "unknown-id",
	contracts: { ...typedResource.contracts, id: unknownIdSchema },
});

void unknownIdResource;

const missingPathParamsDefinition = {
	...typedResource,
	name: "missing-path-params",
	path: "parents/:parentId/children",
	itemPath: ":id",
	idFields: { parentId: "tenantId", id: "id" },
} as const;
// @ts-expect-error literal nested paths require an explicit pathParams configuration.
const missingPathParamsResource = defineCrudResource(missingPathParamsDefinition);

const unexpectedPathParamsDefinition = {
	...typedResource,
	pathParams: {
		contract: z.object({ tenantId: z.string() }),
		fields: { tenantId: "tenantId" },
	},
} as const;
// @ts-expect-error flat collection paths cannot declare pathParams.
const unexpectedPathParamsResource = defineCrudResource(unexpectedPathParamsDefinition);

// @ts-expect-error pathParams contract keys must exactly match its field mappings.
const mismatchedPathParamsContractResource = defineCrudResource({
	...nestedTypedResource,
	name: "mismatched-parent-contract",
	pathParams: {
		contract: z.object({ organizationId: z.string().uuid() }),
		fields: { parentId: "parentId" },
	},
});

// @ts-expect-error every path parameter must be required in the pathParams contract output.
const optionalPathParamResource = defineCrudResource({
	...nestedTypedResource,
	name: "optional-parent-param",
	pathParams: {
		contract: z.object({ parentId: z.string().uuid().optional() }),
		fields: { parentId: "parentId" },
	},
});

// @ts-expect-error parent and item route parameter names must be disjoint.
const overlappingPathParamResource = defineCrudResource({
	...nestedTypedResource,
	name: "overlapping-parent-param",
	itemPath: ":parentId",
	idFields: { parentId: "parentId" },
	contracts: {
		...nestedTypedResource.contracts,
		id: z.object({ parentId: z.string().uuid() }),
	},
});

const nonCanonicalPathParamDefinition = {
	...nestedTypedResource,
	name: "non-canonical-parent-param",
	path: "parents/:parentId?/children",
} as const;
// @ts-expect-error route parameters must be canonical whole :identifier segments.
const nonCanonicalPathParamResource = defineCrudResource(nonCanonicalPathParamDefinition);

const duplicatePathParamDefinition = {
	...nestedTypedResource,
	name: "duplicate-parent-param",
	path: "parents/:parentId/ancestors/:parentId/children",
} as const;
// @ts-expect-error parent route parameter names must be unique.
const duplicatePathParamResource = defineCrudResource(duplicatePathParamDefinition);

// @ts-expect-error parent mappings must be identical in pathParams.fields and idFields.
const mismatchedPathParamMappingResource = defineCrudResource({
	...nestedTypedResource,
	name: "mismatched-parent-mapping",
	idFields: { parentId: "ownerId", childId: "childId" },
});

const mismatchedPathParamTypeDefinition = {
	...nestedTypedResource,
	name: "mismatched-parent-type",
	pathParams: {
		contract: z.object({ parentId: z.coerce.number().int() }),
		fields: { parentId: "parentId" },
	},
} as const;
// @ts-expect-error parent path contract property types must match contracts.id output properties.
const mismatchedPathParamTypeResource = defineCrudResource(mismatchedPathParamTypeDefinition);

// @ts-expect-error enabling generated upsert requires contracts.upsert.
const missingUpsertContractResource = defineCrudResource({
	...typedResource,
	name: "missing-upsert-contract",
	operations: { upsert: {} },
});

void missingPathParamsResource;
void unexpectedPathParamsResource;
void mismatchedPathParamsContractResource;
void optionalPathParamResource;
void overlappingPathParamResource;
void nonCanonicalPathParamResource;
void duplicatePathParamResource;
void mismatchedPathParamMappingResource;
void mismatchedPathParamTypeResource;
void missingUpsertContractResource;

// @ts-expect-error create output is inferred as a number after schema coercion.
export const invalidCreate: CrudCreate<typeof typedResource> = { label: "wrong", count: "1" };

export const invalidBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: new FakeCrudAdapter() },
	fields: ["tenantId", "id", "label", "count"],
	mappings: {
		create: (input) => input,
		update: (input) => input,
		persistence: (values) => values,
		// @ts-expect-error response mapping must satisfy the inferred response input.
		response: () => ({ tenantId: "tenant", id: "wrong", label: "typed", count: 1 }),
	},
});

// @ts-expect-error every composite ID field must be declared by the binding.
export const incompleteFieldBinding = defineCrudBinding({
	resource: typedResource,
	adapter: { useValue: new FakeCrudAdapter() },
	fields: ["id", "label", "count"],
	mappings: {
		create: (input) => input,
		update: (input) => input,
		persistence: (values) => values,
		response: () => ({ tenantId: "tenant", id: 1, label: "typed", count: 1 }),
	},
});

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;

type Assert<Value extends true> = Value;

type ServiceTokenResource<Token> =
	Token extends CrudServiceToken<infer Resource> ? Resource : never;

type BindingCreateValues<Binding> =
	Binding extends CrudResourceBinding<
		AnyCrudResource,
		unknown,
		readonly string[],
		infer CreateValues,
		object
	>
		? CreateValues
		: never;

type BindingUpdateValues<Binding> =
	Binding extends CrudResourceBinding<
		AnyCrudResource,
		unknown,
		readonly string[],
		object,
		infer UpdateValues
	>
		? UpdateValues
		: never;
