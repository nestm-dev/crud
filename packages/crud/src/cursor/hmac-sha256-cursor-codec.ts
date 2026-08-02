import { createHmac, timingSafeEqual } from "node:crypto";

import { CrudCursorError } from "./cursor.error.ts";
import { CRUD_CURSOR_VERSION, type CrudCursor, type CrudCursorCodec } from "./cursor.types.ts";

const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_TOKEN_LENGTH = 16_384;
const MAXIMUM_VALUE_DEPTH = 32;
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

type WireValue =
	| { readonly type: "null" }
	| { readonly type: "string"; readonly value: string }
	| { readonly type: "number"; readonly value: number }
	| { readonly type: "boolean"; readonly value: boolean }
	| { readonly type: "bigint"; readonly value: string }
	| { readonly type: "date"; readonly value: string }
	| { readonly type: "bytes"; readonly value: string }
	| { readonly type: "array"; readonly value: readonly WireValue[] }
	| {
			readonly type: "object";
			readonly value: readonly (readonly [string, WireValue])[];
	  };

interface WireCursor {
	readonly version: typeof CRUD_CURSOR_VERSION;
	readonly resource: string;
	readonly order: readonly {
		readonly field: string;
		readonly direction: "asc" | "desc";
	}[];
	readonly values: readonly WireValue[];
}

/** HMAC-SHA-256 cursor codec with lossless support for common database scalar values. */
export class HmacSha256CrudCursorCodec implements CrudCursorCodec {
	readonly #secret: Uint8Array;

	constructor(secret: string | Uint8Array) {
		const bytes =
			typeof secret === "string" ? Buffer.from(secret, "utf8") : Uint8Array.from(secret);
		if (bytes.byteLength < MINIMUM_SECRET_BYTES) {
			throw new CrudCursorError("invalid_secret");
		}
		this.#secret = bytes;
	}

	encode(cursor: CrudCursor): string {
		try {
			assertCursorShape(cursor);
			const seen = new WeakSet<object>();
			const payload: WireCursor = {
				version: CRUD_CURSOR_VERSION,
				resource: cursor.resource,
				order: cursor.order,
				values: cursor.values.map((value) => encodeWireValue(value, seen)),
			};
			const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
			const signedContent = `v${CRUD_CURSOR_VERSION}.${encodedPayload}`;
			const signature = this.#sign(signedContent).toString("base64url");
			const token = `${signedContent}.${signature}`;
			if (token.length > MAXIMUM_TOKEN_LENGTH) {
				throw new CrudCursorError("invalid_payload");
			}
			return token;
		} catch (cause) {
			if (cause instanceof CrudCursorError) {
				throw cause;
			}
			throw new CrudCursorError("invalid_payload", { cause });
		}
	}

	decode(token: string): CrudCursor {
		if (token.length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) {
			throw new CrudCursorError("malformed");
		}
		const parts = token.split(".");
		if (
			parts.length !== 3 ||
			parts[0] === undefined ||
			parts[1] === undefined ||
			parts[2] === undefined ||
			!TOKEN_PART_PATTERN.test(parts[1]) ||
			!TOKEN_PART_PATTERN.test(parts[2])
		) {
			throw new CrudCursorError("malformed");
		}
		if (parts[0] !== `v${CRUD_CURSOR_VERSION}`) {
			throw new CrudCursorError("unsupported_version");
		}

		const signedContent = `${parts[0]}.${parts[1]}`;
		const suppliedSignature = Buffer.from(parts[2], "base64url");
		const expectedSignature = this.#sign(signedContent);
		if (
			suppliedSignature.toString("base64url") !== parts[2] ||
			suppliedSignature.byteLength !== expectedSignature.byteLength ||
			!timingSafeEqual(suppliedSignature, expectedSignature)
		) {
			throw new CrudCursorError("invalid_signature");
		}

		try {
			const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			const wireCursor = parseWireCursor(parsed);
			const cursor: CrudCursor = {
				version: wireCursor.version,
				resource: wireCursor.resource,
				order: wireCursor.order,
				values: wireCursor.values.map(decodeWireValue),
			};
			assertCursorShape(cursor);
			return cursor;
		} catch (cause) {
			if (cause instanceof CrudCursorError) {
				throw cause;
			}
			throw new CrudCursorError("invalid_payload", { cause });
		}
	}

	#sign(content: string): Buffer {
		return createHmac("sha256", this.#secret).update(content, "utf8").digest();
	}
}

export function createHmacSha256CrudCursorCodec(
	secret: string | Uint8Array,
): HmacSha256CrudCursorCodec {
	return new HmacSha256CrudCursorCodec(secret);
}

function assertCursorShape(cursor: CrudCursor): void {
	if (
		cursor.version !== CRUD_CURSOR_VERSION ||
		cursor.resource.trim() === "" ||
		cursor.order.length === 0 ||
		cursor.values.length !== cursor.order.length ||
		cursor.values.some((value) => value === null || value === undefined)
	) {
		throw new CrudCursorError("invalid_payload");
	}
	const fields = new Set<string>();
	for (const order of cursor.order) {
		if (
			order.field.trim() === "" ||
			(order.direction !== "asc" && order.direction !== "desc") ||
			fields.has(order.field)
		) {
			throw new CrudCursorError("invalid_payload");
		}
		fields.add(order.field);
	}
}

function encodeWireValue(value: unknown, seen: WeakSet<object>, depth = 0): WireValue {
	if (depth > MAXIMUM_VALUE_DEPTH) {
		throw new CrudCursorError("invalid_payload");
	}
	if (value === null) {
		return { type: "null" };
	}
	if (typeof value === "string") {
		return { type: "string", value };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new CrudCursorError("invalid_payload");
		}
		return { type: "number", value };
	}
	if (typeof value === "boolean") {
		return { type: "boolean", value };
	}
	if (typeof value === "bigint") {
		return { type: "bigint", value: value.toString() };
	}
	if (typeof value !== "object" || value === undefined) {
		throw new CrudCursorError("invalid_payload");
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new CrudCursorError("invalid_payload");
		}
		return { type: "date", value: value.toISOString() };
	}
	if (value instanceof Uint8Array) {
		return { type: "bytes", value: Buffer.from(value).toString("base64url") };
	}
	if (seen.has(value)) {
		throw new CrudCursorError("invalid_payload");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return {
				type: "array",
				value: value.map((item) => encodeWireValue(item, seen, depth + 1)),
			};
		}
		if (
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		) {
			throw new CrudCursorError("invalid_payload");
		}
		const entries = Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, encodeWireValue(item, seen, depth + 1)] as const);
		return { type: "object", value: entries };
	} finally {
		seen.delete(value);
	}
}

function decodeWireValue(value: WireValue): unknown {
	switch (value.type) {
		case "null":
			return null;
		case "string":
		case "number":
		case "boolean":
			return value.value;
		case "bigint":
			try {
				return BigInt(value.value);
			} catch (cause) {
				throw new CrudCursorError("invalid_payload", { cause });
			}
		case "date": {
			const date = new Date(value.value);
			if (Number.isNaN(date.getTime()) || date.toISOString() !== value.value) {
				throw new CrudCursorError("invalid_payload");
			}
			return date;
		}
		case "bytes":
			return Uint8Array.from(Buffer.from(value.value, "base64url"));
		case "array":
			return value.value.map(decodeWireValue);
		case "object":
			return Object.fromEntries(
				value.value.map(([key, item]) => [key, decodeWireValue(item)] as const),
			);
	}
}

function parseWireCursor(value: unknown): WireCursor {
	if (!isRecord(value)) {
		throw new CrudCursorError("invalid_payload");
	}
	const { version, resource, order, values } = value;
	if (
		version !== CRUD_CURSOR_VERSION ||
		typeof resource !== "string" ||
		!Array.isArray(order) ||
		!Array.isArray(values)
	) {
		throw new CrudCursorError("invalid_payload");
	}
	const parsedOrder = order.map((item) => {
		if (
			!isRecord(item) ||
			typeof item.field !== "string" ||
			(item.direction !== "asc" && item.direction !== "desc")
		) {
			throw new CrudCursorError("invalid_payload");
		}
		return { field: item.field, direction: item.direction } as const;
	});
	return {
		version,
		resource,
		order: parsedOrder,
		values: values.map(parseWireValue),
	};
}

function parseWireValue(value: unknown, depth = 0): WireValue {
	if (depth > MAXIMUM_VALUE_DEPTH) {
		throw new CrudCursorError("invalid_payload");
	}
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new CrudCursorError("invalid_payload");
	}
	switch (value.type) {
		case "null":
			return { type: "null" };
		case "string":
			if (typeof value.value === "string") return { type: "string", value: value.value };
			break;
		case "number":
			if (typeof value.value === "number" && Number.isFinite(value.value)) {
				return { type: "number", value: value.value };
			}
			break;
		case "boolean":
			if (typeof value.value === "boolean") return { type: "boolean", value: value.value };
			break;
		case "bigint":
		case "date":
		case "bytes":
			if (typeof value.value === "string") {
				return { type: value.type, value: value.value };
			}
			break;
		case "array":
			if (Array.isArray(value.value)) {
				return {
					type: "array",
					value: value.value.map((item) => parseWireValue(item, depth + 1)),
				};
			}
			break;
		case "object":
			if (Array.isArray(value.value)) {
				const entries = value.value.map((entry): readonly [string, WireValue] => {
					if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
						throw new CrudCursorError("invalid_payload");
					}
					return [entry[0], parseWireValue(entry[1], depth + 1)] as const;
				});
				if (new Set(entries.map(([key]) => key)).size !== entries.length) {
					throw new CrudCursorError("invalid_payload");
				}
				return { type: "object", value: entries };
			}
			break;
	}
	throw new CrudCursorError("invalid_payload");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
