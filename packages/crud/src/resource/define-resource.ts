import { CRUD_FILTER_OPERATORS } from "../query/query.types.ts";
import { resolveCrudPaginationModes } from "../query/pagination.ts";
import { getCrudSchema, type CrudSchemaSource } from "../schema/schema.types.ts";
import { CRUD_OPERATION_NAMES, type CrudEnhancers, type CrudOperations } from "./operations.ts";
import {
	CRUD_RESOURCE,
	type AnyCrudResource,
	type DefinedCrudResource,
	type CrudResourceDefinitionConstraint,
	type CrudResourceDefinition,
	type CrudSoftDeleteConfig,
} from "./resource.types.ts";
import type { CrudQueryConfig } from "../query/query.types.ts";
import type { CrudRelationConfig } from "../relation/relation.types.ts";

const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defineCrudResource<
	const Fields extends readonly [string, ...string[]],
	const Definition extends CrudResourceDefinition,
>(
	definition: { readonly fields: Fields } & Definition &
		CrudResourceDefinition<string, string, NoInfer<Fields>> &
		CrudResourceDefinitionConstraint<NoInfer<Definition>>,
): DefinedCrudResource<Definition> {
	assertResourceDefinition(definition);
	return Object.freeze({
		...snapshotResourceDefinition(definition),
		[CRUD_RESOURCE]: true as const,
	}) as DefinedCrudResource<Definition>;
}

export function isCrudResource(value: unknown): value is AnyCrudResource {
	return (
		typeof value === "object" &&
		value !== null &&
		CRUD_RESOURCE in value &&
		value[CRUD_RESOURCE] === true
	);
}

function assertResourceDefinition(definition: CrudResourceDefinition): void {
	if (typeof definition.name !== "string" || definition.name.trim() === "") {
		throw new TypeError("A CRUD resource name cannot be empty.");
	}
	if (typeof definition.path !== "string" || definition.path.trim() === "") {
		throw new TypeError(`CRUD resource "${definition.name}" must declare a path.`);
	}
	if (typeof definition.itemPath !== "string" || definition.itemPath.trim() === "") {
		throw new TypeError(`CRUD resource "${definition.name}" must declare an itemPath.`);
	}
	const pathRouteParams = assertCanonicalRoutePath(definition.name, "path", definition.path);
	const itemRouteParams = assertCanonicalRoutePath(
		definition.name,
		"itemPath",
		definition.itemPath,
	);
	assertUnique(definition.name, "path route parameters", pathRouteParams);
	assertUnique(definition.name, "itemPath route parameters", itemRouteParams);
	const itemRouteParamSet = new Set(itemRouteParams);
	if (pathRouteParams.some((parameter) => itemRouteParamSet.has(parameter))) {
		throw new TypeError(
			`CRUD resource "${definition.name}" path and itemPath parameters must be disjoint.`,
		);
	}
	if (!isRecord(definition.operations) || Object.keys(definition.operations).length === 0) {
		throw new TypeError(
			`CRUD resource "${definition.name}" must explicitly select at least one operation.`,
		);
	}
	for (const operation of Object.keys(definition.operations)) {
		if (!CRUD_OPERATION_NAMES.includes(operation as (typeof CRUD_OPERATION_NAMES)[number])) {
			throw new TypeError(
				`CRUD resource "${definition.name}" has unknown operation "${operation}".`,
			);
		}
		const options = definition.operations[operation as keyof typeof definition.operations];
		if (!isRecord(options)) {
			throw new TypeError(
				`CRUD resource "${definition.name}" operation "${operation}" must be configured with an options object.`,
			);
		}
		if (operation !== "delete" && Object.hasOwn(options, "missing")) {
			throw new TypeError(
				`CRUD resource "${definition.name}" operation "${operation}" cannot configure missing-row behavior.`,
			);
		}
		if (
			operation === "delete" &&
			options.missing !== undefined &&
			options.missing !== "not-found" &&
			options.missing !== "ignore"
		) {
			throw new TypeError(
				`CRUD resource "${definition.name}" operation "delete" missing must be "not-found" or "ignore".`,
			);
		}
	}
	if (!isRecord(definition.contracts)) {
		throw new TypeError(`CRUD resource "${definition.name}" must declare contract schemas.`);
	}
	for (const contract of ["id", "create", "update", "response"] as const) {
		assertSchemaSource(definition.name, `contracts.${contract}`, definition.contracts[contract]);
	}
	if (definition.contracts.upsert !== undefined) {
		assertSchemaSource(definition.name, "contracts.upsert", definition.contracts.upsert);
	}
	if (definition.operations.upsert !== undefined && definition.contracts.upsert === undefined) {
		throw new TypeError(
			`CRUD resource "${definition.name}" cannot enable upsert without contracts.upsert.`,
		);
	}
	if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
		throw new TypeError(`CRUD resource "${definition.name}" must declare logical fields.`);
	}
	for (const field of definition.fields) {
		assertNonEmptyString(definition.name, "fields", field);
	}
	assertUnique(definition.name, "fields", definition.fields);
	if (!isRecord(definition.idFields) || Object.keys(definition.idFields).length === 0) {
		throw new TypeError(`CRUD resource "${definition.name}" must declare idFields.`);
	}
	for (const field of Object.values(definition.idFields)) {
		assertNonEmptyString(definition.name, "idFields", field);
		assertDeclaredField(definition, "idFields", field);
	}

	assertPathParamsConfiguration(definition, pathRouteParams);

	const routeParams = [...pathRouteParams, ...itemRouteParams];
	const idParams = Object.keys(definition.idFields);
	if (
		routeParams.length !== idParams.length ||
		routeParams.some((parameter) => !idParams.includes(parameter))
	) {
		throw new TypeError(
			`CRUD resource "${definition.name}" full route parameters must match idFields exactly.`,
		);
	}
	if (new Set(Object.values(definition.idFields)).size !== idParams.length) {
		throw new TypeError(`CRUD resource "${definition.name}" idFields must map to unique fields.`);
	}
	if (definition.operations.restore !== undefined && definition.softDelete === undefined) {
		throw new TypeError(
			`CRUD resource "${definition.name}" cannot enable restore without softDelete.`,
		);
	}
	if (definition.softDelete !== undefined) {
		assertNonEmptyString(definition.name, "softDelete.field", definition.softDelete.field);
		assertDeclaredField(definition, "softDelete.field", definition.softDelete.field);
	}
	assertQueryConfiguration(definition);
	assertRelationConfiguration(definition);
	assertVersionConfiguration(definition);
}

function snapshotResourceDefinition<Definition extends CrudResourceDefinition>(
	definition: Definition,
): Definition {
	const operations = Object.freeze(
		Object.fromEntries(
			Object.entries(definition.operations).map(([name, options]) => [
				name,
				snapshotEnhancers(options!),
			]),
		),
	) as CrudOperations;
	const query = definition.query === undefined ? undefined : snapshotQuery(definition.query);
	const softDelete =
		definition.softDelete === undefined ? undefined : snapshotSoftDelete(definition.softDelete);
	const relations =
		definition.relations === undefined
			? undefined
			: (Object.freeze(
					Object.fromEntries(
						Object.entries(definition.relations).map(([name, relation]) => [
							name,
							snapshotRelation(relation),
						]),
					),
				) as Definition["relations"]);
	return {
		...definition,
		fields: Object.freeze([...definition.fields]),
		idFields: Object.freeze({ ...definition.idFields }),
		...(definition.pathParams === undefined
			? {}
			: {
					pathParams: Object.freeze({
						contract: snapshotSchemaSource(definition.pathParams.contract),
						fields: Object.freeze({ ...definition.pathParams.fields }),
					}),
				}),
		contracts: Object.freeze({
			id: snapshotSchemaSource(definition.contracts.id),
			create: snapshotSchemaSource(definition.contracts.create),
			update: snapshotSchemaSource(definition.contracts.update),
			response: snapshotSchemaSource(definition.contracts.response),
			...(definition.contracts.upsert === undefined
				? {}
				: { upsert: snapshotSchemaSource(definition.contracts.upsert) }),
		}),
		operations,
		...(query === undefined ? {} : { query }),
		...(softDelete === undefined ? {} : { softDelete }),
		...(relations === undefined ? {} : { relations }),
		...(definition.hooks === undefined ? {} : { hooks: Object.freeze([...definition.hooks]) }),
		...(definition.validators === undefined
			? {}
			: { validators: Object.freeze([...definition.validators]) }),
		...(definition.scopes === undefined ? {} : { scopes: Object.freeze([...definition.scopes]) }),
		...(definition.enhancers === undefined
			? {}
			: { enhancers: snapshotEnhancers(definition.enhancers) }),
		...(definition.tags === undefined ? {} : { tags: Object.freeze([...definition.tags]) }),
		...(Array.isArray(definition.version)
			? { version: Object.freeze([...definition.version]) }
			: {}),
	} as Definition;
}

function snapshotEnhancers<Enhancers extends CrudEnhancers>(enhancers: Enhancers): Enhancers {
	return Object.freeze({
		...enhancers,
		...(enhancers.decorators === undefined
			? {}
			: { decorators: Object.freeze([...enhancers.decorators]) }),
		...(enhancers.guards === undefined ? {} : { guards: Object.freeze([...enhancers.guards]) }),
		...(enhancers.interceptors === undefined
			? {}
			: { interceptors: Object.freeze([...enhancers.interceptors]) }),
		...(enhancers.pipes === undefined ? {} : { pipes: Object.freeze([...enhancers.pipes]) }),
		...(enhancers.filters === undefined ? {} : { filters: Object.freeze([...enhancers.filters]) }),
	}) as Enhancers;
}

function snapshotQuery(query: CrudQueryConfig): CrudQueryConfig {
	return Object.freeze({
		...(query.filters === undefined
			? {}
			: {
					filters: Object.freeze(
						Object.fromEntries(
							Object.entries(query.filters).map(([field, config]) => [
								field,
								Object.freeze({
									...config,
									schema: snapshotSchemaSource(config.schema),
									operators: Object.freeze([...config.operators]),
								}),
							]),
						),
					),
				}),
		...(query.sort === undefined
			? {}
			: {
					sort: Object.freeze({
						...query.sort,
						fields: Object.freeze([...query.sort.fields]),
						...(query.sort.default === undefined
							? {}
							: { default: Object.freeze([...query.sort.default]) }),
						...(query.sort.cursor === undefined
							? {}
							: { cursor: Object.freeze([...query.sort.cursor]) }),
					}),
				}),
		...(query.search === undefined
			? {}
			: {
					search: Object.freeze({
						...query.search,
						fields: Object.freeze([...query.search.fields]),
					}),
				}),
		...(query.pagination === undefined
			? {}
			: { pagination: Object.freeze({ ...query.pagination }) }),
	});
}

function snapshotSchemaSource<Source extends CrudSchemaSource>(source: Source): Source {
	if ("~standard" in source) return source;
	return Object.freeze({ schema: source.schema }) as Source;
}

function snapshotSoftDelete(config: CrudSoftDeleteConfig): CrudSoftDeleteConfig {
	return Object.freeze({
		...config,
		...(config.queryDeletedEnhancers === undefined
			? {}
			: { queryDeletedEnhancers: snapshotEnhancers(config.queryDeletedEnhancers) }),
	});
}

function snapshotRelation<const Relation extends CrudRelationConfig>(relation: Relation): Relation {
	return Object.freeze({
		...relation,
		local: Object.freeze([...relation.local]),
		foreign: Object.freeze([...relation.foreign]),
	}) as Relation;
}

function assertCanonicalRoutePath(resource: string, label: string, path: string): string[] {
	const parameters: string[] = [];
	for (const segment of path.split("/")) {
		if (segment.startsWith(":")) {
			const parameter = segment.slice(1);
			if (!PARAMETER_NAME_PATTERN.test(parameter)) {
				throw new TypeError(
					`CRUD resource "${resource}" ${label} parameters must use canonical ":identifier" path segments.`,
				);
			}
			parameters.push(parameter);
			continue;
		}
		if (segment.includes(":") || segment.includes("*")) {
			throw new TypeError(
				`CRUD resource "${resource}" ${label} parameters must use canonical ":identifier" path segments.`,
			);
		}
	}
	return parameters;
}

function assertPathParamsConfiguration(
	definition: CrudResourceDefinition,
	pathRouteParams: readonly string[],
): void {
	const config = definition.pathParams;
	if (pathRouteParams.length === 0) {
		if (config !== undefined) {
			throw new TypeError(
				`CRUD resource "${definition.name}" cannot declare pathParams when path has no parameters.`,
			);
		}
		return;
	}
	if (!isRecord(config)) {
		throw new TypeError(
			`CRUD resource "${definition.name}" must declare pathParams when path has parameters.`,
		);
	}
	assertSchemaSource(definition.name, "pathParams.contract", config.contract);
	if (!isRecord(config.fields)) {
		throw new TypeError(`CRUD resource "${definition.name}" must declare pathParams.fields.`);
	}
	const fields = config.fields as Readonly<Record<string, unknown>>;
	const fieldParams = Object.keys(fields);
	if (
		fieldParams.length !== pathRouteParams.length ||
		pathRouteParams.some((parameter) => !fieldParams.includes(parameter))
	) {
		throw new TypeError(
			`CRUD resource "${definition.name}" path parameters must match pathParams.fields exactly.`,
		);
	}
	const mappedFields: string[] = [];
	for (const field of Object.values(fields)) {
		assertNonEmptyString(definition.name, "pathParams.fields", field);
		assertDeclaredField(definition, "pathParams.fields", field);
		mappedFields.push(field);
	}
	assertUnique(definition.name, "pathParams.fields mappings", mappedFields);
	for (const parameter of pathRouteParams) {
		if (fields[parameter] !== definition.idFields[parameter]) {
			throw new TypeError(
				`CRUD resource "${definition.name}" pathParams.fields must match parent idFields mappings.`,
			);
		}
	}
}

function assertQueryConfiguration(definition: CrudResourceDefinition): void {
	const name = definition.name;
	for (const [field, config] of Object.entries(definition.query?.filters ?? {})) {
		assertNonEmptyString(name, `filter field`, field);
		assertDeclaredField(definition, "query.filters", field);
		assertSchemaSource(name, `query.filters.${field}.schema`, config.schema);
		if (config.operators.length === 0) {
			throw new TypeError(`CRUD resource "${name}" filter "${field}" must enable an operator.`);
		}
		assertUnique(name, `filter "${field}" operators`, config.operators);
		for (const operator of config.operators) {
			if (!CRUD_FILTER_OPERATORS.includes(operator)) {
				throw new TypeError(
					`CRUD resource "${name}" filter "${field}" has unknown operator "${operator}".`,
				);
			}
		}
	}

	const sort = definition.query?.sort;
	if (sort !== undefined) {
		assertStringList(name, "sort.fields", sort.fields);
		for (const field of sort.fields) assertDeclaredField(definition, "query.sort.fields", field);
		assertUnique(name, "sort.fields", sort.fields);
		const fields = new Set(sort.fields);
		assertSortList(name, "sort.default", sort.default ?? [], fields);
		assertStringList(name, "sort.cursor", sort.cursor ?? []);
		assertUnique(name, "sort.cursor", sort.cursor ?? []);
		for (const field of sort.cursor ?? []) {
			if (!fields.has(field)) {
				throw new TypeError(
					`CRUD resource "${name}" sort.cursor field "${field}" must also appear in sort.fields.`,
				);
			}
		}
	}

	const pagination = definition.query?.pagination;
	const modes = resolveCrudPaginationModes(pagination);
	if (!modes.offset && !modes.cursor) {
		throw new TypeError(`CRUD resource "${name}" must enable a pagination mode.`);
	}
	assertOptionalPositiveInteger(name, "query.pagination.defaultLimit", pagination?.defaultLimit);
	assertOptionalPositiveInteger(name, "query.pagination.maxLimit", pagination?.maxLimit);
	if (
		pagination?.defaultLimit !== undefined &&
		pagination.maxLimit !== undefined &&
		pagination.maxLimit < pagination.defaultLimit
	) {
		throw new TypeError(`CRUD resource "${name}" pagination.maxLimit must be >= defaultLimit.`);
	}
	if (modes.cursor) {
		if (pagination?.maxLimit === Number.MAX_SAFE_INTEGER) {
			throw new TypeError(
				`CRUD resource "${name}" cursor pagination.maxLimit must leave room for overflow detection.`,
			);
		}
		const cursorFields = sort?.cursor;
		if (cursorFields === undefined || cursorFields.length === 0) {
			throw new TypeError(`CRUD resource "${name}" must declare non-nullable sort.cursor fields.`);
		}
		const cursorSafe = new Set([...cursorFields, ...Object.values(definition.idFields)]);
		for (const item of sort?.default ?? []) {
			const field = item.startsWith("-") ? item.slice(1) : item;
			if (!cursorSafe.has(field)) {
				throw new TypeError(
					`CRUD resource "${name}" default sort field "${field}" is not cursor-safe.`,
				);
			}
		}
	}

	const search = definition.query?.search;
	if (search !== undefined) {
		assertStringList(name, "search.fields", search.fields);
		for (const field of search.fields) {
			assertDeclaredField(definition, "query.search.fields", field);
		}
		assertUnique(name, "search.fields", search.fields);
		if (search.fields.length === 0) {
			throw new TypeError(`CRUD resource "${name}" search.fields cannot be empty.`);
		}
		assertOptionalPositiveInteger(name, "query.search.minLength", search.minLength);
		assertOptionalPositiveInteger(name, "query.search.maxLength", search.maxLength);
		const minimum = search.minLength ?? 1;
		const maximum = search.maxLength ?? 200;
		if (maximum < minimum) {
			throw new TypeError(`CRUD resource "${name}" search.maxLength must be >= minLength.`);
		}
	}
}

function assertRelationConfiguration(definition: CrudResourceDefinition): void {
	for (const [relationName, relation] of Object.entries(definition.relations ?? {})) {
		assertNonEmptyString(definition.name, "relation name", relationName);
		if (!(["belongsTo", "hasOne", "hasMany"] as const).includes(relation.type)) {
			throw new TypeError(
				`CRUD resource "${definition.name}" relation "${relationName}" has an invalid type.`,
			);
		}
		if (typeof relation.target !== "function") {
			throw new TypeError(
				`CRUD resource "${definition.name}" relation "${relationName}" must declare a target factory.`,
			);
		}
		if (relation.local.length === 0 || relation.local.length !== relation.foreign.length) {
			throw new TypeError(
				`CRUD resource "${definition.name}" relation "${relationName}" must declare equally-sized, non-empty key tuples.`,
			);
		}
		assertStringList(definition.name, `relation "${relationName}" local`, relation.local);
		assertStringList(definition.name, `relation "${relationName}" foreign`, relation.foreign);
		assertUnique(definition.name, `relation "${relationName}" local`, relation.local);
		for (const field of relation.local) {
			assertDeclaredField(definition, `relation "${relationName}" local`, field);
		}
		assertUnique(definition.name, `relation "${relationName}" foreign`, relation.foreign);
		assertOptionalPositiveInteger(
			definition.name,
			`relation "${relationName}" maxItems`,
			relation.maxItems,
		);
		if (relation.maxItems === Number.MAX_SAFE_INTEGER) {
			throw new TypeError(
				`CRUD resource "${definition.name}" relation "${relationName}" maxItems must leave room for overflow detection.`,
			);
		}
		if (relation.type !== "hasMany" && relation.maxItems !== undefined) {
			throw new TypeError(
				`CRUD resource "${definition.name}" relation "${relationName}" can only set maxItems for hasMany.`,
			);
		}
	}
}

function assertDeclaredField(
	definition: CrudResourceDefinition,
	label: string,
	field: string,
): void {
	if (!definition.fields.includes(field)) {
		throw new TypeError(
			`CRUD resource "${definition.name}" ${label} references undeclared field "${field}".`,
		);
	}
}

function assertVersionConfiguration(definition: CrudResourceDefinition): void {
	if (definition.version === undefined) return;
	const versions = Array.isArray(definition.version) ? definition.version : [definition.version];
	if (versions.length === 0 || new Set(versions).size !== versions.length) {
		throw new TypeError(`CRUD resource "${definition.name}" must declare unique route versions.`);
	}
	for (const version of versions) {
		if (typeof version === "string" && version.trim() === "") {
			throw new TypeError(`CRUD resource "${definition.name}" route versions cannot be empty.`);
		}
	}
}

function assertSortList(
	resource: string,
	label: string,
	items: readonly string[],
	allowed: ReadonlySet<string>,
): void {
	const seen = new Set<string>();
	for (const item of items) {
		assertNonEmptyString(resource, label, item);
		const field = item.startsWith("-") ? item.slice(1) : item;
		if (field === "" || !allowed.has(field)) {
			throw new TypeError(`CRUD resource "${resource}" ${label} has unknown field "${field}".`);
		}
		if (seen.has(field)) {
			throw new TypeError(`CRUD resource "${resource}" ${label} repeats field "${field}".`);
		}
		seen.add(field);
	}
}

function assertStringList(resource: string, label: string, values: readonly string[]): void {
	for (const value of values) assertNonEmptyString(resource, label, value);
}

function assertUnique(
	resource: string,
	label: string,
	values: readonly (string | number | symbol)[],
): void {
	if (new Set(values).size !== values.length) {
		throw new TypeError(`CRUD resource "${resource}" ${label} must contain unique values.`);
	}
}

function assertNonEmptyString(
	resource: string,
	label: string,
	value: unknown,
): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError(`CRUD resource "${resource}" ${label} must contain non-empty strings.`);
	}
}

function assertOptionalPositiveInteger(resource: string, label: string, value: unknown): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)) {
		throw new TypeError(`CRUD resource "${resource}" ${label} must be a positive safe integer.`);
	}
}

function assertSchemaSource(resource: string, label: string, value: unknown): void {
	try {
		const schema = getCrudSchema(value as CrudSchemaSource);
		if (
			typeof schema !== "object" ||
			schema === null ||
			!("~standard" in schema) ||
			typeof schema["~standard"] !== "object" ||
			schema["~standard"] === null ||
			schema["~standard"].version !== 1 ||
			typeof schema["~standard"].validate !== "function"
		) {
			throw new TypeError();
		}
	} catch {
		throw new TypeError(`CRUD resource "${resource}" ${label} must be a Standard Schema source.`);
	}
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null;
}
