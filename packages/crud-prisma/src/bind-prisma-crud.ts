import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingUpsertOptions,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type DefineCrudBindingOptions,
	type CrudPersistenceField,
	type CrudScopeCreateField,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";

type BindableResource = CrudResourceBinding["resource"];

export type PrismaCrudAdapterProvider<
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	QueryField extends string = string,
> = CrudAdapterProvider<
	RecordType,
	CreateValues,
	UpdateValues,
	CrudPersistenceField<CreateValues>,
	QueryField
>;

interface BindPrismaCrudOptionsBase<
	Resource extends BindableResource,
	RecordType,
	CreateValues extends object,
	UpdateValues extends object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[],
	QueryField extends string,
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>,
		NoInfer<ScopeCreateFields[number]>
	>;
	/** Insert fields supplied by path parameters or CRUD scopes through `mappings.scopeCreate`. */
	readonly scopeCreateFields?: ScopeCreateFields;
	/** Atomic-upsert persistence fields. The configured adapter must advertise that capability. */
	readonly upsert?: CrudBindingUpsertOptions<CrudPersistenceField<CreateValues>>;
	/** Standard Nest provider form for an adapter; injected Prisma clients remain application-owned. */
	readonly adapter: PrismaCrudAdapterProvider<RecordType, CreateValues, UpdateValues, QueryField>;
}

export type BindPrismaCrudOptions<
	Resource extends BindableResource,
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
	QueryField extends string = Resource["fields"][number],
> = BindPrismaCrudOptionsBase<
	Resource,
	RecordType,
	CreateValues,
	UpdateValues,
	ScopeCreateFields,
	QueryField
> &
	CompleteCrudFieldSelection<Resource, QueryField>;

/** Creates a core binding without connecting or disconnecting the application's PrismaClient. */
export function bindPrismaCrud<
	const Resource extends BindableResource,
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	const ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
	QueryField extends string = Resource["fields"][number],
>(
	options: BindPrismaCrudOptions<
		Resource,
		RecordType,
		CreateValues,
		UpdateValues,
		ScopeCreateFields,
		QueryField
	>,
): CrudResourceBinding<
	Resource,
	RecordType,
	CreateValues,
	UpdateValues,
	ScopeCreateFields[number],
	CrudPersistenceField<CreateValues>,
	QueryField
> {
	return defineCrudBinding<
		Resource,
		RecordType,
		CreateValues,
		UpdateValues,
		ScopeCreateFields,
		CrudPersistenceField<CreateValues>,
		QueryField
	>(
		options as DefineCrudBindingOptions<
			Resource,
			RecordType,
			CreateValues,
			UpdateValues,
			ScopeCreateFields,
			CrudPersistenceField<CreateValues>,
			QueryField
		>,
	);
}
