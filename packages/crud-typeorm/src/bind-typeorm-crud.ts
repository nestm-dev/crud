import {
	defineCrudBinding,
	type CrudAdapterProvider,
	type CrudBindingMappings,
	type CrudBindingUpsertOptions,
	type CompleteCrudFieldSelection,
	type CrudScopeCreateField,
	type CrudResourceBinding,
} from "@nestm/crud/adapter";
import type { ModuleMetadata } from "@nestjs/common";
import type { DeepPartial, ObjectLiteral } from "typeorm";

import type { TypeOrmCrudAdapter } from "./typeorm-adapter.ts";

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
> = CrudAdapterProvider<RecordType, DeepPartial<EntityType>, DeepPartial<EntityType>>;

interface BindTypeOrmCrudOptionsBase<
	Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	RecordType extends ObjectLiteral,
	Fields extends readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[],
> {
	readonly resource: Resource;
	readonly imports?: ModuleMetadata["imports"];
	readonly fields: Fields;
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
	readonly upsert?: CrudBindingUpsertOptions;
	/** Standard Nest provider form for an adapter; injected repositories remain application-owned. */
	readonly adapter: TypeOrmCrudAdapterProvider<EntityType, RecordType>;
}

export type BindTypeOrmCrudOptions<
	Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	Fields extends readonly string[] = readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[] = readonly [],
	RecordType extends ObjectLiteral = EntityType,
> = BindTypeOrmCrudOptionsBase<Resource, EntityType, RecordType, Fields, ScopeCreateFields> &
	CompleteCrudFieldSelection<Resource, Fields>;

type BindTypeOrmCrudValueOptions<
	Resource extends BindableResource,
	Adapter,
	Fields extends readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<TypeOrmCrudAdapterEntity<Adapter>>[],
> = Omit<
	BindTypeOrmCrudOptions<
		Resource,
		TypeOrmCrudAdapterEntity<Adapter>,
		Fields,
		ScopeCreateFields,
		TypeOrmCrudAdapterRecord<Adapter>
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
	Fields extends readonly string[],
	ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[],
> = Omit<
	BindTypeOrmCrudOptions<Resource, EntityType, Fields, ScopeCreateFields, RecordType>,
	"adapter"
> & {
	readonly adapter: Exclude<
		TypeOrmCrudAdapterProvider<EntityType, RecordType>,
		{ readonly useValue: unknown }
	>;
};

/** Creates a core binding without taking ownership of the application's DataSource or Repository. */
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	const Adapter,
	const Fields extends readonly string[],
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<
		TypeOrmCrudAdapterEntity<Adapter>
	>[] = readonly [],
>(
	options: BindTypeOrmCrudValueOptions<Resource, Adapter, Fields, ScopeCreateFields>,
): CrudResourceBinding<
	Resource,
	TypeOrmCrudAdapterRecord<Adapter>,
	Fields,
	DeepPartial<TypeOrmCrudAdapterEntity<Adapter>>,
	DeepPartial<TypeOrmCrudAdapterEntity<Adapter>>,
	ScopeCreateFields[number]
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	const Fields extends readonly string[],
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[] = readonly [],
	RecordType extends ObjectLiteral = EntityType,
>(
	options: BindTypeOrmCrudInjectedOptions<
		Resource,
		EntityType,
		RecordType,
		Fields,
		ScopeCreateFields
	>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	DeepPartial<EntityType>,
	DeepPartial<EntityType>,
	ScopeCreateFields[number]
>;
export function bindTypeOrmCrud<
	const Resource extends BindableResource,
	EntityType extends ObjectLiteral,
	const Fields extends readonly string[],
	const ScopeCreateFields extends readonly TypeOrmScopeCreateField<EntityType>[] = readonly [],
	RecordType extends ObjectLiteral = EntityType,
>(
	options: BindTypeOrmCrudOptions<Resource, EntityType, Fields, ScopeCreateFields, RecordType>,
): CrudResourceBinding<
	Resource,
	RecordType,
	Fields,
	DeepPartial<EntityType>,
	DeepPartial<EntityType>,
	ScopeCreateFields[number]
> {
	return defineCrudBinding({
		...options,
		adapter: options.adapter,
	});
}
