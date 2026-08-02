import type { CrudAfterCommitErrorHandler } from "../runtime/runtime.types.ts";

export interface CrudCursorOptions {
	readonly secret: string | Uint8Array;
}

export interface CrudPaginationDefaults {
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
}

export interface CrudModuleOptions {
	readonly cursor?: CrudCursorOptions;
	readonly pagination?: CrudPaginationDefaults;
	readonly maxRelatedRows?: number;
	readonly afterCommitErrorHandler?: CrudAfterCommitErrorHandler;
}

export interface ResolvedCrudModuleOptions {
	readonly cursor?: CrudCursorOptions;
	readonly pagination: Required<CrudPaginationDefaults>;
	readonly maxRelatedRows: number;
	readonly afterCommitErrorHandler: CrudAfterCommitErrorHandler;
}

export function resolveCrudModuleOptions(options: CrudModuleOptions): ResolvedCrudModuleOptions {
	const defaultLimit = options.pagination?.defaultLimit ?? 20;
	const maxLimit = options.pagination?.maxLimit ?? 100;
	if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1) {
		throw new TypeError("CRUD pagination.defaultLimit must be a positive integer.");
	}
	if (!Number.isSafeInteger(maxLimit) || maxLimit < defaultLimit) {
		throw new TypeError("CRUD pagination.maxLimit must be an integer >= defaultLimit.");
	}
	const maxRelatedRows = options.maxRelatedRows ?? 100;
	if (
		!Number.isSafeInteger(maxRelatedRows) ||
		maxRelatedRows < 1 ||
		maxRelatedRows === Number.MAX_SAFE_INTEGER
	) {
		throw new TypeError(
			"CRUD maxRelatedRows must be a positive integer below Number.MAX_SAFE_INTEGER.",
		);
	}
	return {
		...(options.cursor === undefined ? {} : { cursor: options.cursor }),
		pagination: { defaultLimit, maxLimit },
		maxRelatedRows,
		afterCommitErrorHandler:
			options.afterCommitErrorHandler ??
			(async () => {
				// Deliberately no console fallback: applications that care about delivery
				// failures provide an error sink, while CRUD never leaks hook errors.
			}),
	};
}
