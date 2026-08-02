export type CrudAdapterErrorCode = "conflict" | "constraint" | "unsupported" | "unknown";

const CRUD_ADAPTER_ERROR = Symbol.for("@nestm/crud:adapter-error");

const CRUD_ADAPTER_ERROR_CODES: Readonly<Record<CrudAdapterErrorCode, true>> = Object.freeze({
	conflict: true,
	constraint: true,
	unsupported: true,
	unknown: true,
});

export class CrudAdapterError extends Error {
	readonly [CRUD_ADAPTER_ERROR] = true;
	readonly code: CrudAdapterErrorCode;
	/** Whether retrying the complete operation in a fresh transaction can succeed. */
	readonly retryable: boolean;
	override readonly cause?: unknown;

	constructor(
		code: CrudAdapterErrorCode,
		message: string,
		options: { cause?: unknown; retryable?: boolean } = {},
	) {
		super(message);
		this.name = "CrudAdapterError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.cause = options.cause;
	}
}

/** Narrows adapter errors structurally, including errors from another package copy. */
export function isCrudAdapterError(value: unknown): value is CrudAdapterError {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly [CRUD_ADAPTER_ERROR]?: unknown;
		readonly code?: unknown;
		readonly message?: unknown;
		readonly name?: unknown;
		readonly retryable?: unknown;
	};
	return (
		(candidate[CRUD_ADAPTER_ERROR] === true || candidate.name === "CrudAdapterError") &&
		typeof candidate.message === "string" &&
		typeof candidate.code === "string" &&
		Object.hasOwn(CRUD_ADAPTER_ERROR_CODES, candidate.code) &&
		typeof candidate.retryable === "boolean"
	);
}
