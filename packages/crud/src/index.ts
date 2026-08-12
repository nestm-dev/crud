export { CrudModule } from "./module/crud.module.ts";
export type { CrudFeatureOptions, CrudModuleAsyncOptions } from "./module/crud.module.ts";
export { defineCrudFactoryProvider } from "./module/factory-provider.types.ts";
export type {
	CrudFactoryDependency,
	CrudFactoryDependencyTuple,
	CrudFactoryProvider,
} from "./module/factory-provider.types.ts";
export type {
	CrudCursorOptions,
	CrudModuleOptions,
	CrudPaginationDefaults,
	ResolvedCrudModuleOptions,
} from "./module/crud-module.options.ts";
export { getCrudServiceToken, type CrudServiceToken } from "./module/crud.tokens.ts";

export { defineCrudResource, isCrudResource } from "./resource/define-resource.ts";
export { crudOperations, CRUD_OPERATION_NAMES } from "./resource/operations.ts";
export type {
	CrudEnhancers,
	CrudOperationName,
	CrudOperationOptions,
	CrudOperations,
} from "./resource/operations.ts";
export type {
	AnyCrudResource,
	CrudContracts,
	CrudCreate,
	CrudRequiredField,
	DefinedCrudResource,
	CrudHookType,
	CrudId,
	CrudPathParams,
	CrudPathParamsConfig,
	CrudResource,
	CrudResourceDefinition,
	CrudResponse,
	CrudResponseInput,
	CrudScopeType,
	CrudValidatorType,
	CrudSoftDeleteConfig,
	CrudUpdate,
	CrudUpsert,
	CrudVersion,
} from "./resource/resource.types.ts";

export { defineCrudRelation } from "./relation/relation.types.ts";
export type { CrudRelationConfig, CrudRelationType } from "./relation/relation.types.ts";

export { CrudService } from "./runtime/crud.service.ts";
export type {
	CrudAfterCommitErrorContext,
	CrudAfterCommitErrorHandler,
	CrudLifecycleHook,
	CrudMutationValidator,
	CrudCollectionArgs,
	CrudMutationEvent,
	CrudOperationContext,
	CrudProjection,
	CrudScope,
	CrudScopeResult,
	CrudValidationContext,
} from "./runtime/runtime.types.ts";
export { defineCrudFact, provideCrudFact } from "./runtime/crud-facts.ts";
export type { CrudFact, CrudFactEntry, CrudFacts } from "./runtime/crud-facts.ts";
export { CrudContext } from "./controller/crud-context.decorator.ts";
export { InjectCrud } from "./controller/inject-crud.decorator.ts";

export {
	CRUD_FILTER_OPERATORS,
	CrudQueryValidationError,
	andCrudPredicates,
	buildCrudOrder,
	orCrudPredicates,
	parseCrudListQuery,
	resolveCrudPaginationModes,
} from "./query/index.ts";
export type { CrudPaginationModes } from "./query/pagination.ts";
export type {
	CrudCursorMeta,
	CrudCursorQuery,
	CrudFilterFieldConfig,
	CrudFilterOperator,
	CrudListQuery,
	CrudOffsetMeta,
	CrudOffsetQuery,
	CrudOrder,
	CrudPage,
	CrudPageMeta,
	CrudPaginationConfig,
	CrudPredicate,
	CrudQueryConfig,
	CrudQueryParserOptions,
	CrudRawQuery,
	CrudSearchConfig,
	CrudSortConfig,
	CrudSortDirection,
} from "./query/query.types.ts";

export {
	CRUD_CURSOR_VERSION,
	CrudCursorError,
	HmacSha256CrudCursorCodec,
	createHmacSha256CrudCursorCodec,
	decodeCrudCursor,
	encodeCrudCursor,
} from "./cursor/index.ts";
export type {
	CrudCursor,
	CrudCursorBinding,
	CrudCursorCodec,
	CrudCursorErrorCode,
	CrudCursorFixedValue,
} from "./cursor/cursor.types.ts";

export {
	createCrudPageSchema,
	withCrudStandardSchemaConverter,
	type CrudPageSchema,
} from "./schema/page-schema.ts";
export {
	CrudSchemaValidationError,
	getCrudSchema,
	parseCrudSchema,
} from "./schema/schema.types.ts";
export type {
	CrudSchemaSource,
	CrudStandardSchema,
	SchemaInput,
	SchemaOf,
	SchemaOutput,
} from "./schema/schema.types.ts";
