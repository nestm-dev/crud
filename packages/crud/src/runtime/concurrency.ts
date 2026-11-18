import {
	HttpException,
	HttpStatus,
	PreconditionFailedException,
	type ExecutionContext,
} from "@nestjs/common";

/** Optimistic concurrency policy for a resource's row version. */
export interface CrudConcurrencyConfig<Field extends string = string> {
	/**
	 * Logical field holding the row version, for example a TypeORM `@VersionColumn`. Its value
	 * is the entity tag: responses carry `ETag: "<version>"`, and writes must send it back in
	 * `If-Match`.
	 */
	readonly field: Field;
	/**
	 * Whether CRUD writes `version + 1` itself on every update, soft delete, and restore.
	 * Leave it off when the persistence layer bumps the version (TypeORM `@VersionColumn`, a
	 * database trigger). Requires a numeric or bigint version and `mappings.persistence`.
	 * @default false
	 */
	readonly increment?: boolean;
}

/**
 * Explicit preconditions for direct `CrudService` writes. When omitted, CRUD reads the
 * `If-Match` / `If-None-Match` headers of the HTTP request in the execution context.
 */
export interface CrudWritePreconditions {
	/** Raw `If-Match` value: one or more entity tags previously returned as `ETag`. */
	readonly ifMatch?: string | undefined;
	/** Raw `If-None-Match` value. Only `*` is supported, and only by upsert (create-only PUT). */
	readonly ifNoneMatch?: string | undefined;
}

/** HTTP 428: the resource requires a conditional request. */
export class CrudPreconditionRequiredException extends HttpException {
	constructor(message = "This request requires an If-Match header.") {
		super(
			{ statusCode: HttpStatus.PRECONDITION_REQUIRED, message, error: "Precondition Required" },
			HttpStatus.PRECONDITION_REQUIRED,
		);
		this.name = "CrudPreconditionRequiredException";
	}
}

/** Precondition state resolved for one write. */
export type CrudResolvedPrecondition =
	{ readonly kind: "match"; readonly tags: readonly string[] } | { readonly kind: "create-only" };

/**
 * Resolves the preconditions for a write against a concurrency-enabled resource.
 *
 * - No usable `If-Match` (absent, empty, or `*`) → 428. `*` is refused because it would let
 *   a client opt out of lost-update protection.
 * - `If-None-Match: *` is accepted only where `allowCreateOnly` (upsert): it means "create, and
 *   fail with 412 if the row exists". Any other `If-None-Match` value → 428.
 * - A malformed `If-Match` cannot match any version → 412.
 */
export function resolveCrudWritePrecondition(
	preconditions: CrudWritePreconditions,
	allowCreateOnly: boolean,
): CrudResolvedPrecondition {
	const ifMatch = preconditions.ifMatch?.trim() ?? "";
	const ifNoneMatch = preconditions.ifNoneMatch?.trim() ?? "";
	if (ifNoneMatch !== "") {
		if (!allowCreateOnly || ifNoneMatch !== "*") {
			throw new CrudPreconditionRequiredException(
				allowCreateOnly
					? 'This request requires If-Match, or If-None-Match: "*" to create.'
					: "This request requires an If-Match header.",
			);
		}
		if (ifMatch !== "") {
			throw new PreconditionFailedException("If-Match and If-None-Match: * cannot both hold.");
		}
		return { kind: "create-only" };
	}
	if (ifMatch === "" || ifMatch === "*") {
		throw new CrudPreconditionRequiredException(
			allowCreateOnly
				? 'This request requires If-Match with an entity tag, or If-None-Match: "*" to create.'
				: "This request requires If-Match with an entity tag.",
		);
	}
	const tags = parseCrudEntityTags(ifMatch);
	if (tags === undefined) {
		throw new PreconditionFailedException("If-Match does not contain a valid entity tag.");
	}
	return { kind: "match", tags };
}

/**
 * Parses an `If-Match` list into opaque tags. Strong (`"3"`) and weak (`W/"3"`) tags compare
 * equal, because intermediaries may weaken a strong tag (for example when compressing). A bare
 * unquoted token (`3`) is accepted for clients that drop the quotes. Returns `undefined` for a
 * malformed header.
 */
export function parseCrudEntityTags(header: string): readonly string[] | undefined {
	const tags: string[] = [];
	let index = 0;
	const skipSeparators = (): void => {
		while (index < header.length && /[\s,]/u.test(header[index]!)) index += 1;
	};
	skipSeparators();
	while (index < header.length) {
		if (header.startsWith("W/", index)) index += 2;
		if (header[index] === '"') {
			const end = header.indexOf('"', index + 1);
			if (end < 0) return undefined;
			tags.push(header.slice(index + 1, end));
			index = end + 1;
		} else {
			const match = /^[^\s,"]+/u.exec(header.slice(index));
			if (match === null) return undefined;
			tags.push(match[0]);
			index += match[0].length;
		}
		const separator = /^\s*(?:,|$)/u.exec(header.slice(index));
		if (separator === null) return undefined;
		index += separator[0].length;
		skipSeparators();
	}
	return tags.length === 0 ? undefined : tags;
}

/** Opaque entity tag (without quotes) for a version value, or `undefined` for none. */
export function crudVersionTag(version: unknown): string | undefined {
	if (version === null || version === undefined) return undefined;
	if (version instanceof Date) return version.toISOString();
	if (typeof version === "number" || typeof version === "bigint" || typeof version === "string") {
		const tag = String(version);
		if (/["\s]/u.test(tag) || tag === "") {
			throw new TypeError("CRUD version values cannot contain quotes or whitespace.");
		}
		return tag;
	}
	throw new TypeError("CRUD version values must be strings, numbers, bigints, or dates.");
}

/** `ETag` header value for a version tag. */
export function formatCrudEntityTag(tag: string): string {
	return `"${tag}"`;
}

/** The next value of a CRUD-managed version. */
export function nextCrudVersion(version: unknown): number | bigint {
	if (typeof version === "bigint") return version + 1n;
	if (
		typeof version === "number" &&
		Number.isSafeInteger(version) &&
		version < Number.MAX_SAFE_INTEGER
	) {
		return version + 1;
	}
	throw new TypeError("CRUD-managed versions must be safe integers or bigints.");
}

/** Reads the request's precondition headers when the context is an HTTP request. */
export function readCrudWritePreconditions(
	executionContext: ExecutionContext | undefined,
): CrudWritePreconditions {
	if (executionContext === undefined || executionContext.getType() !== "http") return {};
	const request: unknown = executionContext.switchToHttp().getRequest();
	const headers =
		typeof request === "object" && request !== null && "headers" in request
			? request.headers
			: undefined;
	if (typeof headers !== "object" || headers === null) return {};
	const ifMatch = headerValue(headers, "if-match");
	const ifNoneMatch = headerValue(headers, "if-none-match");
	return {
		...(ifMatch === undefined ? {} : { ifMatch }),
		...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
	};
}

/** Sets a response header on an Express response or a Fastify reply. */
export function setCrudResponseHeader(
	executionContext: ExecutionContext | undefined,
	name: string,
	value: string,
): void {
	if (executionContext === undefined || executionContext.getType() !== "http") return;
	const response: unknown = executionContext.switchToHttp().getResponse();
	if (typeof response !== "object" || response === null) return;
	// Express's `res.header` and Fastify's `reply.header` share this signature; a raw Node
	// response only offers `setHeader`.
	if ("header" in response && typeof response.header === "function") {
		(response.header as (name: string, value: string) => unknown).call(response, name, value);
	} else if ("setHeader" in response && typeof response.setHeader === "function") {
		(response.setHeader as (name: string, value: string) => unknown).call(response, name, value);
	}
}

function headerValue(headers: object, name: string): string | undefined {
	const value: unknown = Reflect.get(headers, name);
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value.join(", ");
	}
	return undefined;
}
