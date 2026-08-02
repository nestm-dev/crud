import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";
import type { DeepPartial, ObjectLiteral } from "typeorm";

import type { TypeOrmCrudAdapter } from "./typeorm-adapter.ts";

type BindableResource = CrudResourceBinding["resource"];

export type TypeOrmCrudAdapterProvider<RecordType extends ObjectLiteral> = CrudAdapterProvider<
	RecordType,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>
>;

interface BindTypeOrmCrudOptionsBase<
	Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	Fields extends readonly string[],
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly fields: Fields;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		DeepPartial<RecordType>,
		DeepPartial<RecordType>
	>;
	/** Standard Nest provider form for an adapter; injected repositories remain application-owned. */
	readonly adapter: TypeOrmCrudAdapterProvider<RecordType>;
}

export type BindTypeOrmCrudOptions<
	Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	Fields extends readonly string[] = readonly string[],
> = BindTypeOrmCrudOptionsBase<Resource, RecordType, Fields> &
	CompleteCrudFieldSelection<Resource, Fields>;

type BindTypeOrmCrudValueOptions<
	Resource extends BindableResource,
	Adapter,
	Fields extends readonly string[],
> = Omit<BindTypeOrmCrudOptions<Resource, TypeOrmCrudAdapterRecord<Adapter>, Fields>, "adapter"> & {
	readonly adapter: [TypeOrmCrudAdapterRecord<Adapter>] extends [never]
		? never
		: { readonly useValue: Adapter };
};

type TypeOrmCrudAdapterRecord<Adapter> =
	Adapter extends TypeOrmCrudAdapter<infer RecordType> ? RecordType : never;

type BindTypeOrmCrudInjectedOptions<
	Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	Fields extends readonly string[],
> = Omit<BindTypeOrmCrudOptions<Resource, RecordType, Fields>, "adapter"> & {
	readonly adapter: Exclude<TypeOrmCrudAdapterProvider<RecordType>, { readonly useValue: unknown }>;
};

/** Creates a core binding without taking ownership of the application's DataSource or Repository. */
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	const Adapter,
	const Fields extends readonly string[],
>(
	options: BindTypeOrmCrudValueOptions<Resource, Adapter, Fields>,
): CrudResourceBinding<
	Resource,
	TypeOrmCrudAdapterRecord<Adapter>,
	Fields,
	DeepPartial<TypeOrmCrudAdapterRecord<Adapter>>,
	DeepPartial<TypeOrmCrudAdapterRecord<Adapter>>
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	const Fields extends readonly string[],
>(
	options: BindTypeOrmCrudInjectedOptions<Resource, RecordType, Fields>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	const Fields extends readonly string[],
>(
	options: BindTypeOrmCrudOptions<Resource, RecordType, Fields>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>
> {
	return defineCrudBinding({
		...options,
		adapter: options.adapter,
	});
}
