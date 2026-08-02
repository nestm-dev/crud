export type CrudAdapterErrorCode = "conflict" | "constraint" | "unsupported" | "unknown";

export class CrudAdapterError extends Error {
	readonly code: CrudAdapterErrorCode;
	override readonly cause?: unknown;

	constructor(code: CrudAdapterErrorCode, message: string, options: { cause?: unknown } = {}) {
		super(message);
		this.name = "CrudAdapterError";
		this.code = code;
		this.cause = options.cause;
	}
}
