import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CompleteCrudFieldSelection,
	type CrudScopeCreateField,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";
import type { DeepPartial, ObjectLiteral } from "typeorm";

import type { TypeOrmCrudAdapter } from "./typeorm-adapter.ts";

type BindableResource = CrudResourceBinding["resource"];

/**
 * Insert fields a CRUD scope owns, for a record whose create and update values are
 * both `DeepPartial<RecordType>`.
 *
 * The TypeORM adapter derives both value types from the record, so a scope-owned
 * field is any writable property path on the entity.
 */
type TypeOrmScopeCreateField<RecordType extends ObjectLiteral> = CrudScopeCreateField<
	DeepPartial<RecordType>,
	DeepPartial<RecordType>
>;

export type TypeOrmCrudAdapterProvider<RecordType extends ObjectLiteral> = CrudAdapterProvider<
	RecordType,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>
>;

interface BindTypeOrmCrudOptionsBase<
	Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	Fields extends readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<RecordType>[],
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly fields: Fields;
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		DeepPartial<RecordType>,
		DeepPartial<RecordType>,
		NoInfer<ScopeCreateFields[number]>
	>;
	/**
	 * Insert fields supplied by CRUD scopes through `mappings.scopeCreate`.
	 *
	 * Declaring them makes those fields optional in `mappings.create` and asserted
	 * present at insert time, which is what keeps an insert-only field such as an
	 * owner id out of `mappings.persistence` — the update path shares that mapper,
	 * so a field expressible there is a field a client can change.
	 */
	readonly scopeCreateFields?: ScopeCreateFields;
	/** Standard Nest provider form for an adapter; injected repositories remain application-owned. */
	readonly adapter: TypeOrmCrudAdapterProvider<RecordType>;
}

export type BindTypeOrmCrudOptions<
	Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	Fields extends readonly string[] = readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<RecordType>[] = readonly [],
> = BindTypeOrmCrudOptionsBase<Resource, RecordType, Fields, ScopeCreateFields> &
	CompleteCrudFieldSelection<Resource, Fields>;

type BindTypeOrmCrudValueOptions<
	Resource extends BindableResource,
	Adapter,
	Fields extends readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<TypeOrmCrudAdapterRecord<Adapter>>[],
> = Omit<
	BindTypeOrmCrudOptions<Resource, TypeOrmCrudAdapterRecord<Adapter>, Fields, ScopeCreateFields>,
	"adapter"
> & {
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
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<RecordType>[],
> = Omit<BindTypeOrmCrudOptions<Resource, RecordType, Fields, ScopeCreateFields>, "adapter"> & {
	readonly adapter: Exclude<TypeOrmCrudAdapterProvider<RecordType>, { readonly useValue: unknown }>;
};

/** Creates a core binding without taking ownership of the application's DataSource or Repository. */
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	const Adapter,
	const Fields extends readonly string[],
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<
		TypeOrmCrudAdapterRecord<Adapter>
	>[] = readonly [],
>(
	options: BindTypeOrmCrudValueOptions<Resource, Adapter, Fields, ScopeCreateFields>,
): CrudResourceBinding<
	Resource,
	TypeOrmCrudAdapterRecord<Adapter>,
	Fields,
	DeepPartial<TypeOrmCrudAdapterRecord<Adapter>>,
	DeepPartial<TypeOrmCrudAdapterRecord<Adapter>>,
	ScopeCreateFields[number]
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	const Fields extends readonly string[],
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<RecordType>[] = readonly [],
>(
	options: BindTypeOrmCrudInjectedOptions<Resource, RecordType, Fields, ScopeCreateFields>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>,
	ScopeCreateFields[number]
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	RecordType extends ObjectLiteral,
	const Fields extends readonly string[],
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<RecordType>[] = readonly [],
>(
	options: BindTypeOrmCrudOptions<Resource, RecordType, Fields, ScopeCreateFields>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>,
	ScopeCreateFields[number]
> {
	return defineCrudBinding({
		...options,
		adapter: options.adapter,
	});
}
