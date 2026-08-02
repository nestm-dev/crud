import type { CrudOrder } from "../query/query.types.ts";

export const CRUD_CURSOR_VERSION = 1 as const;

export interface CrudCursor {
	readonly version: typeof CRUD_CURSOR_VERSION;
	readonly resource: string;
	readonly order: readonly CrudOrder[];
	readonly values: readonly unknown[];
}

export interface CrudCursorBinding {
	readonly resource: string;
	readonly order: readonly CrudOrder[];
}

/** Adapter-independent cursor serialization contract. */
export interface CrudCursorCodec {
	encode(cursor: CrudCursor): string | Promise<string>;
	decode(token: string): CrudCursor | Promise<CrudCursor>;
}

export const CRUD_CURSOR_ERROR_CODES = [
	"invalid_secret",
	"malformed",
	"unsupported_version",
	"invalid_signature",
	"invalid_payload",
	"binding_mismatch",
] as const;

export type CrudCursorErrorCode = (typeof CRUD_CURSOR_ERROR_CODES)[number];
