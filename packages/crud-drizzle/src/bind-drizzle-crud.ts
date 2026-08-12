import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingUpsertOptions,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type CrudScopeCreateField,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";

type BindableResource = CrudResourceBinding["resource"];

export type DrizzleCrudAdapterProvider<
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;

interface BindDrizzleCrudOptionsBase<
	Resource extends BindableResource,
	RecordType,
	Fields extends readonly string[],
	CreateValues extends object,
	UpdateValues extends object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[],
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly fields: Fields;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>,
		NoInfer<ScopeCreateFields[number]>
	>;
	/** Insert fields supplied by CRUD scopes through `mappings.scopeCreate`. */
	readonly scopeCreateFields?: ScopeCreateFields;
	/** Atomic-upsert persistence fields. The configured adapter must advertise that capability. */
	readonly upsert?: CrudBindingUpsertOptions;
	/** Standard Nest provider form for an adapter; injected databases remain application-owned. */
	readonly adapter: DrizzleCrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
}

export type BindDrizzleCrudOptions<
	Resource extends BindableResource,
	RecordType,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
> = BindDrizzleCrudOptionsBase<
	Resource,
	RecordType,
	Fields,
	CreateValues,
	UpdateValues,
	ScopeCreateFields
> &
	CompleteCrudFieldSelection<Resource, Fields>;

/** Creates a core binding without taking ownership of the application's Drizzle client. */
export function bindDrizzleCrud<
	const Resource extends BindableResource,
	RecordType,
	const Fields extends readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	const ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
>(
	options: BindDrizzleCrudOptions<
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
	return defineCrudBinding(options);
}
