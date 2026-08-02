import type { CrudPaginationConfig } from "./query.types.ts";

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
