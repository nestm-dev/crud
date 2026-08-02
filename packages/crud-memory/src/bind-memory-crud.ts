import type { ModuleMetadata } from "@nestjs/common";
import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type DefineCrudBindingOptions,
	type CrudResourceBinding,
	type CrudValues,
} from "@nestm/crud/adapter";

import { MemoryCrudAdapter, type MemoryCrudAdapterOptions } from "./memory-crud-adapter.ts";

type MemoryCrudResource = CrudResourceBinding["resource"];

interface BindMemoryCrudOptionsBase<
	Resource extends MemoryCrudResource,
	RecordType = CrudValues,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
> extends MemoryCrudAdapterOptions<RecordType, CreateValues, UpdateValues> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly fields: Fields;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		NoInfer<CreateValues>,
		NoInfer<UpdateValues>
	>;
	/** Overrides the convenient package-owned adapter with any standard Nest provider form. */
	readonly adapter?: CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
}

export type BindMemoryCrudOptions<
	Resource extends MemoryCrudResource,
	RecordType = CrudValues,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = BindMemoryCrudOptionsBase<Resource, RecordType, Fields, CreateValues, UpdateValues> &
	CompleteCrudFieldSelection<Resource, Fields>;

/** Creates a core binding without installing or owning any external dependency. */
export function bindMemoryCrud<
	const Resource extends MemoryCrudResource,
	RecordType = CrudValues,
	const Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
>(
	options: BindMemoryCrudOptions<Resource, RecordType, Fields, CreateValues, UpdateValues>,
): CrudResourceBinding<Resource, RecordType, Fields, CreateValues, UpdateValues> {
	const {
		resource,
		imports,
		fields,
		mappings,
		adapter,
		store,
		initialRecords,
		clone,
		createRecord,
		updateRecord,
		getField,
		unique,
	} = options;

	const resolvedAdapter: CrudAdapterProvider<RecordType, CreateValues, UpdateValues> = adapter ?? {
		useValue: new MemoryCrudAdapter<RecordType, CreateValues, UpdateValues>({
			...(store === undefined ? {} : { store }),
			...(initialRecords === undefined ? {} : { initialRecords }),
			...(clone === undefined ? {} : { clone }),
			...(createRecord === undefined ? {} : { createRecord }),
			...(updateRecord === undefined ? {} : { updateRecord }),
			...(getField === undefined ? {} : { getField }),
			...(unique === undefined ? {} : { unique }),
		}),
	};

	const coreOptions = {
		resource,
		...(imports === undefined ? {} : { imports }),
		fields,
		mappings,
		adapter: resolvedAdapter,
	} as unknown as DefineCrudBindingOptions<
		Resource,
		RecordType,
		Fields,
		CreateValues,
		UpdateValues
	>;
	return defineCrudBinding<Resource, RecordType, Fields, CreateValues, UpdateValues>(coreOptions);
}
