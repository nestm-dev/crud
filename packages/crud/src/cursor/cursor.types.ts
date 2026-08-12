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
	/**
	 * Ordered fields whose values are fixed by the collection route rather than
	 * chosen by the client, for example a nested resource's parent identity.
	 *
	 * The values already occur in the cursor keyset. Binding them here prevents
	 * a valid cursor issued for one parent collection from being replayed under
	 * another parent with the same resource and ordering.
	 */
	readonly fixed?: readonly CrudCursorFixedValue[];
}

export interface CrudCursorFixedValue {
	readonly field: string;
	readonly value: unknown;
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
