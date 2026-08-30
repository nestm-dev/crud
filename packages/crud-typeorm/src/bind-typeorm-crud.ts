import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CrudBindingUpsertOptions,
	type CompleteCrudFieldSelection,
	type DefineCrudBindingOptions,
	type CrudScopeCreateField,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";
import type { DeepPartial, ObjectLiteral } from "typeorm";

import type { TypeOrmCrudAdapter } from "./typeorm-adapter.ts";
import type { TypeOrmCrudPropertyPath } from "./typeorm-adapter.ts";

type BindableResource = CrudResourceBinding["resource"];

/**
 * Insert fields a CRUD scope owns, for an entity whose create and update values are
 * both `DeepPartial<EntityType>`.
 *
 * The TypeORM adapter derives both value types from the record, so a scope-owned
 * field is any writable property path on the entity.
 */
type TypeOrmScopeCreateField<EntityType extends ObjectLiteral> = CrudScopeCreateField<
	DeepPartial<EntityType>,
	DeepPartial<EntityType>
>;

export type TypeOrmCrudAdapterProvider<
	EntityType extends ObjectLiteral,
	RecordType extends ObjectLiteral = EntityType,
	LogicalField extends string = TypeOrmCrudPropertyPath<EntityType>,
> = CrudAdapterProvider<
	RecordType,
	DeepPartial<EntityType>,
	DeepPartial<EntityType>,
	TypeOrmCrudPropertyPath<EntityType>,
	LogicalField
>;

interface BindTypeOrmCrudOptionsBase<
	Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	RecordType extends ObjectLiteral,
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[],
	LogicalField extends string,
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly mappings: CrudBindingMappings<
		Resource,
		NoInfer<RecordType>,
		DeepPartial<EntityType>,
		DeepPartial<EntityType>,
		NoInfer<ScopeCreateFields[number]>
	>;
	/**
	 * Insert fields supplied by CRUD scopes. Same-name values are copied automatically;
	 * `mappings.scopeCreate` is only needed for custom name translation.
	 *
	 * Declaring them makes those fields optional in `mappings.create` and asserted
	 * present at insert time, which is what keeps an insert-only field such as an
	 * owner id out of `mappings.persistence` — the update path shares that mapper,
	 * so a field expressible there is a field a client can change.
	 */
	readonly scopeCreateFields?: ScopeCreateFields;
	/** Atomic upsert conflict-target and mutable-overwrite persistence paths. */
	readonly upsert?: CrudBindingUpsertOptions<TypeOrmCrudPropertyPath<EntityType>>;
	/** Standard Nest provider form for an adapter; injected repositories remain application-owned. */
	readonly adapter: TypeOrmCrudAdapterProvider<EntityType, RecordType, LogicalField>;
}

export type BindTypeOrmCrudOptions<
	Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[] = readonly [],
	RecordType extends ObjectLiteral = EntityType,
	LogicalField extends string = TypeOrmCrudPropertyPath<EntityType>,
> = BindTypeOrmCrudOptionsBase<Resource, EntityType, RecordType, ScopeCreateFields, LogicalField> &
	CompleteCrudFieldSelection<Resource, LogicalField>;

export type TypeOrmCrudAdapterLogicalField<Adapter> =
	Adapter extends TypeOrmCrudAdapter<infer _EntityType, infer _RecordType, infer LogicalField>
		? LogicalField
		: never;

type BindTypeOrmCrudValueOptions<
	Resource extends BindableResource,
	Adapter,
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<TypeOrmCrudAdapterEntity<Adapter>>[],
> = Omit<
	BindTypeOrmCrudOptions<
		Resource,
		TypeOrmCrudAdapterEntity<Adapter>,
		ScopeCreateFields,
		TypeOrmCrudAdapterRecord<Adapter>,
		TypeOrmCrudAdapterLogicalField<Adapter>
	>,
	"adapter"
> & {
	readonly adapter: [TypeOrmCrudAdapterEntity<Adapter>] extends [never]
		? never
		: { readonly useValue: Adapter };
};

type TypeOrmCrudAdapterEntity<Adapter> =
	Adapter extends TypeOrmCrudAdapter<infer EntityType, infer _RecordType> ? EntityType : never;

type TypeOrmCrudAdapterRecord<Adapter> =
	Adapter extends TypeOrmCrudAdapter<infer _EntityType, infer RecordType> ? RecordType : never;

type BindTypeOrmCrudInjectedOptions<
	Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	RecordType extends ObjectLiteral,
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[],
> = Omit<BindTypeOrmCrudOptions<Resource, EntityType, ScopeCreateFields, RecordType>, "adapter"> & {
	readonly adapter: Exclude<
		TypeOrmCrudAdapterProvider<EntityType, RecordType>,
		{ readonly useValue: unknown }
	>;
};

/** Creates a core binding without taking ownership of the application's DataSource or Repository. */
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	const Adapter,
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<
		TypeOrmCrudAdapterEntity<Adapter>
	>[] = readonly [],
>(
	options: BindTypeOrmCrudValueOptions<Resource, Adapter, ScopeCreateFields>,
): CrudResourceBinding<
	Resource,
	TypeOrmCrudAdapterRecord<Adapter>,
	DeepPartial<TypeOrmCrudAdapterEntity<Adapter>>,
	DeepPartial<TypeOrmCrudAdapterEntity<Adapter>>,
	ScopeCreateFields[number],
	TypeOrmCrudPropertyPath<TypeOrmCrudAdapterEntity<Adapter>>,
	TypeOrmCrudAdapterLogicalField<Adapter>
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[] = readonly [],
	RecordType extends ObjectLiteral = EntityType,
>(
	options: BindTypeOrmCrudInjectedOptions<Resource, EntityType, RecordType, ScopeCreateFields>,
): CrudResourceBinding<
	Resource,
	RecordType,
	DeepPartial<EntityType>,
	DeepPartial<EntityType>,
	ScopeCreateFields[number],
	TypeOrmCrudPropertyPath<EntityType>,
	TypeOrmCrudPropertyPath<EntityType>
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[] = readonly [],
	RecordType extends ObjectLiteral = EntityType,
	LogicalField extends string = string,
>(
	options: BindTypeOrmCrudOptions<
		Resource,
		EntityType,
		ScopeCreateFields,
		RecordType,
		LogicalField
	>,
): CrudResourceBinding<
	Resource,
	RecordType,
	DeepPartial<EntityType>,
	DeepPartial<EntityType>,
	ScopeCreateFields[number],
	TypeOrmCrudPropertyPath<EntityType>,
	LogicalField
> {
	return defineCrudBinding<
		Resource,
		RecordType,
		DeepPartial<EntityType>,
		DeepPartial<EntityType>,
		ScopeCreateFields,
		TypeOrmCrudPropertyPath<EntityType>,
		LogicalField
	>(
		options as unknown as DefineCrudBindingOptions<
			Resource,
			RecordType,
			DeepPartial<EntityType>,
			DeepPartial<EntityType>,
			ScopeCreateFields,
			TypeOrmCrudPropertyPath<EntityType>,
			LogicalField
		>,
	);
}
