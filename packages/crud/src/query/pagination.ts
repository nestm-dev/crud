import type { CrudPaginationConfig, CrudPaginationParameterNames } from "./query.types.ts";

export interface CrudPaginationModes {
	readonly offset: boolean;
	readonly cursor: boolean;
}

/** Resolves the public pagination defaults consistently across runtime and OpenAPI. */
export function resolveCrudPaginationModes(
	config: CrudPaginationConfig | undefined,
): CrudPaginationModes {
	const cursor = config?.cursor === true;
	return {
		offset: config?.offset ?? !cursor,
		cursor,
	};
}

/** Resolves the public names of the bracket grammar's pagination parameters. */
export function resolveCrudPaginationParameterNames(
	config: CrudPaginationConfig | undefined,
): Required<CrudPaginationParameterNames> {
	return {
		page: config?.parameters?.page ?? "page",
		limit: config?.parameters?.limit ?? "limit",
		after: config?.parameters?.after ?? "after",
	};
}
