import { CrudCursorError } from "./cursor.error.ts";
import {
	CRUD_CURSOR_VERSION,
	type CrudCursor,
	type CrudCursorBinding,
	type CrudCursorCodec,
} from "./cursor.types.ts";

export async function encodeCrudCursor(
	codec: CrudCursorCodec,
	binding: CrudCursorBinding,
	values: readonly unknown[],
): Promise<string> {
	return codec.encode({
		version: CRUD_CURSOR_VERSION,
		resource: binding.resource,
		order: binding.order,
		values,
	});
}

/** Decodes a cursor and verifies that it belongs to the requested resource and exact ordering. */
export async function decodeCrudCursor(
	codec: CrudCursorCodec,
	token: string,
	binding: CrudCursorBinding,
): Promise<CrudCursor> {
	let cursor: CrudCursor;
	try {
		cursor = await codec.decode(token);
	} catch (cause) {
		if (cause instanceof CrudCursorError) {
			throw cause;
		}
		throw new CrudCursorError("invalid_payload", { cause });
	}
	if (
		cursor.version !== CRUD_CURSOR_VERSION ||
		cursor.resource !== binding.resource ||
		!ordersEqual(cursor.order, binding.order) ||
		cursor.values.length !== binding.order.length
	) {
		throw new CrudCursorError("binding_mismatch");
	}
	return cursor;
}

function ordersEqual(
	left: readonly { readonly field: string; readonly direction: "asc" | "desc" }[],
	right: readonly { readonly field: string; readonly direction: "asc" | "desc" }[],
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(item, index) =>
				item.field === right[index]?.field && item.direction === right[index]?.direction,
		)
	);
}
