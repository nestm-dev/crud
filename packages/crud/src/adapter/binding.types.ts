import type { InjectionToken, ModuleMetadata, Type } from "@nestjs/common";

import type { CrudFactoryDependency } from "../module/factory-provider.types.ts";
import type {
	AnyCrudResource,
	CrudCreate,
	CrudRequiredField,
	CrudResponseInput,
	CrudUpdate,
} from "../resource/resource.types.ts";
import type { CrudAdapter, CrudValues } from "./adapter.types.ts";

export const CRUD_BINDING = Symbol.for("@nestm/crud:binding");

interface CrudCompatibleFactoryProvider<Result> {
	readonly inject?: readonly CrudFactoryDependency[];
	readonly useFactory: (...dependencies: never[]) => Result | Promise<Result>;
}

export type CrudAdapterProvider<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> =
	| { readonly useValue: CrudAdapter<RecordType, CreateValues, UpdateValues> }
	| { readonly useClass: Type<CrudAdapter<RecordType, CreateValues, UpdateValues>> }
	| {
			readonly useExisting: InjectionToken<CrudAdapter<RecordType, CreateValues, UpdateValues>>;
	  }
	| CrudCompatibleFactoryProvider<CrudAdapter<RecordType, CreateValues, UpdateValues>>;

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
> = Omit<CreateValues, ScopeCreateField> & Partial<Pick<CreateValues, ScopeCreateField>>;

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
	 * Maps logical values supplied by CRUD scopes to adapter insert fields.
	 *
	 * Define this mapping for new scoped bindings. For compatibility, bindings
	 * that omit it fall back to `persistence`, but that fallback cannot express
	 * immutable insert-only fields and will be removed in the next major release.
	 */
	scopeCreate?(
		values: CrudValues,
	):
		| Partial<Pick<CreateValues, ScopeCreateField>>
		| Promise<Partial<Pick<CreateValues, ScopeCreateField>>>;
	update(input: CrudUpdate<Resource>): UpdateValues | Promise<UpdateValues>;
	/**
	 * Maps framework-generated logical update values (explicit scope `updateValues`
	 * and soft delete) to the adapter's update input.
	 */
	persistence(values: CrudValues): UpdateValues | Promise<UpdateValues>;
	response(
		record: RecordType,
		relations: Readonly<Record<string, unknown>>,
	): CrudResponseInput<Resource> | Promise<CrudResponseInput<Resource>>;
}

export interface CrudResourceBinding<
	Resource extends AnyCrudResource = AnyCrudResource,
	RecordType = unknown,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateField extends keyof CreateValues = never,
> {
	readonly [CRUD_BINDING]: true;
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly adapter: CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>,
		NoInfer<ScopeCreateField>
	>;
	/** Adapter insert fields supplied by scopes through `mappings.scopeCreate`. */
	readonly scopeCreateFields?: readonly string[];
	readonly fields: Fields;
}

export type MissingCrudBindingFields<
	Resource extends AnyCrudResource,
	Fields extends readonly string[],
> = Exclude<CrudRequiredField<Resource>, Fields[number]>;

export type CompleteCrudFieldSelection<
	Resource extends AnyCrudResource,
	Fields extends readonly string[],
> = [MissingCrudBindingFields<Resource, Fields>] extends [never]
	? unknown
	: {
			/** @internal Compile-time diagnostic listing required logical fields. */
			readonly __missingCrudFields: MissingCrudBindingFields<Resource, Fields>;
		};

export type DefineCrudBindingOptions<
	Resource extends AnyCrudResource,
	RecordType,
	Fields extends readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
> = Omit<
	CrudResourceBinding<
		Resource,
		RecordType,
		Fields,
		CreateValues,
		UpdateValues,
		ScopeCreateFields[number]
	>,
	typeof CRUD_BINDING | "mappings" | "scopeCreateFields"
> & {
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>,
		NoInfer<ScopeCreateFields[number]>
	>;
	readonly scopeCreateFields?: ScopeCreateFields;
} & CompleteCrudFieldSelection<Resource, Fields>;

export function defineCrudBinding<
	Resource extends AnyCrudResource,
	RecordType,
	const Fields extends readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	const ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
>(
	options: DefineCrudBindingOptions<
		Resource,
		RecordType,
		Fields,
		CreateValues,
		UpdateValues,
		ScopeCreateFields
	>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	CreateValues,
	UpdateValues,
	ScopeCreateFields[number]
> {
	const { scopeCreateFields, ...bindingOptions } = options;
	const adapter = Object.freeze({
		...options.adapter,
		...("inject" in options.adapter && options.adapter.inject !== undefined
			? { inject: Object.freeze([...options.adapter.inject]) }
			: {}),
	}) as CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
	return Object.freeze({
		...bindingOptions,
		...(options.imports === undefined ? {} : { imports: Object.freeze([...options.imports]) }),
		adapter,
		mappings: Object.freeze({ ...options.mappings }),
		...(scopeCreateFields === undefined
			? {}
			: { scopeCreateFields: Object.freeze([...scopeCreateFields]) }),
		fields: Object.freeze([...options.fields]) as unknown as Fields,
		[CRUD_BINDING]: true as const,
	}) as unknown as CrudResourceBinding<
		Resource,
		RecordType,
		Fields,
		CreateValues,
		UpdateValues,
		ScopeCreateFields[number]
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
