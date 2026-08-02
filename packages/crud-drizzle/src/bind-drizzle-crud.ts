import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
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
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly fields: Fields;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>
	>;
	/** Standard Nest provider form for an adapter; injected databases remain application-owned. */
	readonly adapter: DrizzleCrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
}

export type BindDrizzleCrudOptions<
	Resource extends BindableResource,
	RecordType,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = BindDrizzleCrudOptionsBase<Resource, RecordType, Fields, CreateValues, UpdateValues> &
	CompleteCrudFieldSelection<Resource, Fields>;

/** Creates a core binding without taking ownership of the application's Drizzle client. */
export function bindDrizzleCrud<
	const Resource extends BindableResource,
	RecordType,
	const Fields extends readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
>(
	options: BindDrizzleCrudOptions<Resource, RecordType, Fields, CreateValues, UpdateValues>,
): CrudResourceBinding<Resource, RecordType, Fields, CreateValues, UpdateValues> {
	return defineCrudBinding(options);
}
