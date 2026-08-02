import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";

type BindableResource = CrudResourceBinding["resource"];

export type PrismaCrudAdapterProvider<
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;

interface BindPrismaCrudOptionsBase<
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
	/** Standard Nest provider form for an adapter; injected Prisma clients remain application-owned. */
	readonly adapter: PrismaCrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
}

export type BindPrismaCrudOptions<
	Resource extends BindableResource,
	RecordType,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = BindPrismaCrudOptionsBase<Resource, RecordType, Fields, CreateValues, UpdateValues> &
	CompleteCrudFieldSelection<Resource, Fields>;

/** Creates a core binding without connecting or disconnecting the application's PrismaClient. */
export function bindPrismaCrud<
	const Resource extends BindableResource,
	RecordType,
	const Fields extends readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
>(
	options: BindPrismaCrudOptions<Resource, RecordType, Fields, CreateValues, UpdateValues>,
): CrudResourceBinding<Resource, RecordType, Fields, CreateValues, UpdateValues> {
	return defineCrudBinding(options);
}
