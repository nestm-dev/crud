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
	assertFixedValues(binding, values);
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
	assertFixedValues(binding, cursor.values);
	return cursor;
}

function assertFixedValues(binding: CrudCursorBinding, values: readonly unknown[]): void {
	for (const fixed of binding.fixed ?? []) {
		const indices = binding.order.flatMap((order, index) =>
			order.field === fixed.field ? [index] : [],
		);
		if (indices.length !== 1 || !cursorValuesEqual(values[indices[0]!], fixed.value)) {
			throw new CrudCursorError("binding_mismatch");
		}
	}
}

function cursorValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (left instanceof Date || right instanceof Date) {
		return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
	}
	if (left instanceof Uint8Array || right instanceof Uint8Array) {
		return (
			left instanceof Uint8Array &&
			right instanceof Uint8Array &&
			left.length === right.length &&
			left.every((value, index) => value === right[index])
		);
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => cursorValuesEqual(value, right[index]))
		);
	}
	if (isPlainObject(left) || isPlainObject(right)) {
		if (!isPlainObject(left) || !isPlainObject(right)) return false;
		const leftKeys = Object.keys(left).toSorted();
		const rightKeys = Object.keys(right).toSorted();
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every(
				(key, index) => key === rightKeys[index] && cursorValuesEqual(left[key], right[key]),
			)
		);
	}
	return false;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
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
