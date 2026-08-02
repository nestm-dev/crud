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

export interface CrudBindingMappings<
	Resource extends AnyCrudResource = AnyCrudResource,
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> {
	create(input: CrudCreate<Resource>): CreateValues | Promise<CreateValues>;
	update(input: CrudUpdate<Resource>): UpdateValues | Promise<UpdateValues>;
	/**
	 * Maps framework-generated logical field values (scopes and soft delete) to the
	 * adapter's update input. Scope values are merged over the mapped create/update input.
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
> {
	readonly [CRUD_BINDING]: true;
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly adapter: CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>
	>;
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
> = Omit<
	CrudResourceBinding<Resource, RecordType, Fields, CreateValues, UpdateValues>,
	typeof CRUD_BINDING
> &
	CompleteCrudFieldSelection<Resource, Fields>;

export function defineCrudBinding<
	Resource extends AnyCrudResource,
	RecordType,
	const Fields extends readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
>(
	options: DefineCrudBindingOptions<Resource, RecordType, Fields, CreateValues, UpdateValues>,
): CrudResourceBinding<Resource, RecordType, Fields, CreateValues, UpdateValues> {
	const adapter = Object.freeze({
		...options.adapter,
		...("inject" in options.adapter && options.adapter.inject !== undefined
			? { inject: Object.freeze([...options.adapter.inject]) }
			: {}),
	}) as CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
	return Object.freeze({
		...options,
		...(options.imports === undefined ? {} : { imports: Object.freeze([...options.imports]) }),
		adapter,
		mappings: Object.freeze({ ...options.mappings }),
		fields: Object.freeze([...options.fields]) as unknown as Fields,
		[CRUD_BINDING]: true as const,
	});
}

export function isCrudBinding(value: unknown): value is CrudResourceBinding {
	return (
		typeof value === "object" &&
		value !== null &&
		CRUD_BINDING in value &&
		value[CRUD_BINDING] === true
	);
}
