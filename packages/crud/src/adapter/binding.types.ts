import type { InjectionToken, ModuleMetadata, Type } from "@nestjs/common";

import type { CrudFactoryDependency } from "../module/factory-provider.types.ts";
import type {
	AnyCrudResource,
	CrudCreate,
	CrudField,
	CrudFieldValues,
	CrudId,
	CrudResponseInput,
	CrudUpdate,
	CrudUpsert,
} from "../resource/resource.types.ts";
import type {
	CrudAdapter,
	CrudPersistenceField,
	CrudPersistenceFieldTuple,
} from "./adapter.types.ts";

export const CRUD_BINDING = Symbol.for("@nestm/crud:binding");

interface CrudCompatibleFactoryProvider<Result> {
	readonly inject?: readonly CrudFactoryDependency[];
	readonly useFactory: (...dependencies: never[]) => Result | Promise<Result>;
}

export type CrudAdapterProvider<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = string,
> =
	| {
			readonly useValue: CrudAdapter<
				RecordType,
				CreateValues,
				UpdateValues,
				PersistenceField,
				QueryField
			>;
	  }
	| {
			readonly useClass: Type<
				CrudAdapter<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField>
			>;
	  }
	| {
			readonly useExisting: InjectionToken<
				CrudAdapter<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField>
			>;
	  }
	| CrudCompatibleFactoryProvider<
			CrudAdapter<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField>
	  >;

/** Adapter insert fields that are materialized from scope-owned logical values. */
export type CrudScopeCreateField<
	CreateValues extends object,
	_UpdateValues extends object = object,
> = Extract<keyof CreateValues, string>;

/**
 * Values returned by an API create mapper before scope-owned persistence fields are merged.
 * Unscoped bindings use the default `never` and therefore still require `CreateValues` in full.
 */
export type CrudCreateMappingValues<
	CreateValues extends object,
	ScopeCreateField extends keyof CreateValues = never,
> = Omit<CrudMappingValues<CreateValues>, ScopeCreateField> &
	Partial<Pick<CrudMappingValues<CreateValues>, ScopeCreateField>>;

/**
 * Adapter values accepted from a mapping callback before CRUD removes
 * explicitly `undefined` optional properties.
 *
 * Standard Schema outputs commonly represent an optional property as
 * `field?: Value | undefined`, while persistence models compiled with
 * `exactOptionalPropertyTypes` represent the same value as `field?: Value`.
 * Mappers may return either form; CRUD normalizes the former before invoking
 * the adapter without weakening required persistence properties.
 */
export type CrudMappingValues<Values extends object> = {
	[Field in keyof Values]: object extends Pick<Values, Field>
		? Values[Field] | undefined
		: Values[Field];
};

export interface CrudBindingMappings<
	Resource extends AnyCrudResource = AnyCrudResource,
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateField extends keyof CreateValues = never,
> {
	create(
		input: CrudCreate<Resource>,
	):
		| CrudCreateMappingValues<CreateValues, ScopeCreateField>
		| Promise<CrudCreateMappingValues<CreateValues, ScopeCreateField>>;
	/**
	 * Maps logical values supplied by CRUD scopes to differently named adapter fields.
	 *
	 * Omit this for ordinary same-name fields declared by `scopeCreateFields`; CRUD
	 * copies and validates those values automatically. Dynamic custom mappings keep
	 * `unknown` inputs because scopes are application code and may supply any value.
	 */
	scopeCreate?(
		values: CrudFieldValues<Resource>,
	):
		| CrudMappingValues<Partial<Pick<CreateValues, ScopeCreateField>>>
		| Promise<CrudMappingValues<Partial<Pick<CreateValues, ScopeCreateField>>>>;
	update(
		input: CrudUpdate<Resource>,
	): CrudMappingValues<UpdateValues> | Promise<CrudMappingValues<UpdateValues>>;
	/** Maps an upsert request and its complete identity to one proposed persistence row. */
	upsert?(
		id: CrudId<Resource>,
		input: CrudUpsert<Resource>,
	):
		| CrudCreateMappingValues<CreateValues, ScopeCreateField>
		| Promise<CrudCreateMappingValues<CreateValues, ScopeCreateField>>;
	/**
	 * Maps framework-generated logical update values (explicit scope `updateValues`
	 * and soft delete) to the adapter's update input.
	 */
	persistence?(
		values: CrudFieldValues<Resource>,
	): CrudMappingValues<UpdateValues> | Promise<CrudMappingValues<UpdateValues>>;
	/**
	 * `projected` carries the merged output of the resource's {@link CrudProjection}s for this
	 * record, or `undefined` when the resource declares none. A two-argument implementation stays
	 * assignable here, so every existing binding compiles untouched.
	 */
	response(
		record: RecordType,
		relations: Readonly<Record<string, unknown>>,
		projected?: Readonly<Record<string, unknown>>,
	): CrudResponseInput<Resource> | Promise<CrudResponseInput<Resource>>;
}

export interface CrudBindingUpsertOptions<PersistenceField extends string = string> {
	/** Complete, non-empty adapter persistence paths forming the conflict target. */
	readonly conflictFields: CrudPersistenceFieldTuple<PersistenceField>;
	/** Adapter persistence paths copied from the proposed insert row on conflict. */
	readonly overwriteFields: CrudPersistenceFieldTuple<PersistenceField>;
}

export interface CrudResourceBinding<
	Resource extends AnyCrudResource = AnyCrudResource,
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateField extends keyof CreateValues = never,
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = CrudField<Resource>,
> {
	readonly [CRUD_BINDING]: true;
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly adapter: CrudAdapterProvider<
		RecordType,
		CreateValues,
		UpdateValues,
		PersistenceField,
		QueryField
	>;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>,
		NoInfer<ScopeCreateField>
	>;
	/** Adapter insert fields supplied by scopes, with automatic same-name mapping. */
	readonly scopeCreateFields?: readonly ([Extract<keyof CreateValues, string>] extends [never]
		? string
		: ScopeCreateField)[];
	/** Required adapter-level configuration when the resource enables atomic upsert. */
	readonly upsert?: CrudBindingUpsertOptions<PersistenceField>;
}

export type MissingCrudBindingFields<
	Resource extends AnyCrudResource,
	QueryField extends string,
> = Exclude<CrudField<Resource>, QueryField>;

export type CompleteCrudFieldSelection<
	Resource extends AnyCrudResource,
	QueryField extends string,
> = [MissingCrudBindingFields<Resource, QueryField>] extends [never]
	? unknown
	: {
			/** @internal Compile-time diagnostic listing required logical fields. */
			readonly __missingCrudFields: MissingCrudBindingFields<Resource, QueryField>;
		};

export type DefineCrudBindingOptions<
	Resource extends AnyCrudResource,
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = CrudField<Resource>,
> = Omit<
	CrudResourceBinding<
		Resource,
		RecordType,
		CreateValues,
		UpdateValues,
		ScopeCreateFields[number],
		PersistenceField,
		QueryField
	>,
	typeof CRUD_BINDING | "mappings" | "scopeCreateFields" | "upsert"
> & {
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>,
		NoInfer<ScopeCreateFields[number]>
	>;
	readonly scopeCreateFields?: ScopeCreateFields;
	readonly upsert?: CrudBindingUpsertOptions<NoInfer<PersistenceField>>;
} & CompleteCrudFieldSelection<Resource, QueryField>;

export function defineCrudBinding<
	Resource extends AnyCrudResource,
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	const ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = CrudField<Resource>,
>(
	options: DefineCrudBindingOptions<
		Resource,
		RecordType,
		CreateValues,
		UpdateValues,
		ScopeCreateFields,
		PersistenceField,
		QueryField
	>,
): CrudResourceBinding<
	Resource,
	RecordType,
	CreateValues,
	UpdateValues,
	ScopeCreateFields[number],
	PersistenceField,
	QueryField
> {
	const { scopeCreateFields, upsert, ...bindingOptions } = options;
	const adapter = Object.freeze({
		...options.adapter,
		...("inject" in options.adapter && options.adapter.inject !== undefined
			? { inject: Object.freeze([...options.adapter.inject]) }
			: {}),
	}) as CrudAdapterProvider<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField>;
	return Object.freeze({
		...bindingOptions,
		...(options.imports === undefined ? {} : { imports: Object.freeze([...options.imports]) }),
		adapter,
		mappings: Object.freeze({ ...options.mappings }),
		...(scopeCreateFields === undefined
			? {}
			: { scopeCreateFields: Object.freeze([...scopeCreateFields]) }),
		...(upsert === undefined
			? {}
			: {
					upsert: Object.freeze({
						...upsert,
						conflictFields: Object.freeze([...upsert.conflictFields]),
						overwriteFields: Object.freeze([...upsert.overwriteFields]),
					}),
				}),
		[CRUD_BINDING]: true as const,
	}) as unknown as CrudResourceBinding<
		Resource,
		RecordType,
		CreateValues,
		UpdateValues,
		ScopeCreateFields[number],
		PersistenceField,
		QueryField
	>;
}

export function isCrudBinding(value: unknown): value is CrudResourceBinding {
	return (
		typeof value === "object" &&
		value !== null &&
		CRUD_BINDING in value &&
		value[CRUD_BINDING] === true
	);
}
