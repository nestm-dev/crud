import type { ModuleMetadata } from "@nestjs/common";
import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingUpsertOptions,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type DefineCrudBindingOptions,
	type CrudScopeCreateField,
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
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
> extends MemoryCrudAdapterOptions<RecordType, CreateValues, UpdateValues> {
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
	/** Insert fields supplied by path parameters or CRUD scopes through `mappings.scopeCreate`. */
	readonly scopeCreateFields?: ScopeCreateFields;
	/** Atomic-upsert persistence fields. The configured adapter must advertise that capability. */
	readonly upsert?: CrudBindingUpsertOptions;
	/** Overrides the convenient package-owned adapter with any standard Nest provider form. */
	readonly adapter?: CrudAdapterProvider<RecordType, CreateValues, UpdateValues>;
}

export type BindMemoryCrudOptions<
	Resource extends MemoryCrudResource,
	RecordType = CrudValues,
	Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
> = BindMemoryCrudOptionsBase<
	Resource,
	RecordType,
	Fields,
	CreateValues,
	UpdateValues,
	ScopeCreateFields
> &
	CompleteCrudFieldSelection<Resource, Fields>;

/** Creates a core binding without installing or owning any external dependency. */
export function bindMemoryCrud<
	const Resource extends MemoryCrudResource,
	RecordType = CrudValues,
	const Fields extends readonly string[] = readonly string[],
	CreateValues extends object = object,
	UpdateValues extends object = object,
	const ScopeCreateFields extends readonly CrudScopeCreateField<CreateValues, UpdateValues>[] =
		readonly [],
>(
	options: BindMemoryCrudOptions<
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
	const {
		resource,
		imports,
		fields,
		mappings,
		scopeCreateFields,
		upsert,
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
		...(scopeCreateFields === undefined ? {} : { scopeCreateFields }),
		...(upsert === undefined ? {} : { upsert }),
		adapter: resolvedAdapter,
	} as unknown as DefineCrudBindingOptions<
		Resource,
		RecordType,
		Fields,
		CreateValues,
		UpdateValues,
		ScopeCreateFields
	>;
	return defineCrudBinding<
		Resource,
		RecordType,
		Fields,
		CreateValues,
		UpdateValues,
		ScopeCreateFields
	>(coreOptions);
}
