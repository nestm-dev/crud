import { BadRequestException } from "@nestjs/common";

import type { CrudQueryErrorCode } from "./query.types.ts";

export interface CrudQueryValidationErrorOptions {
	readonly parameter?: string;
	readonly cause?: unknown;
}

/** A query error that preserves Nest's standard HTTP 400 response envelope. */
export class CrudQueryValidationError extends BadRequestException {
	readonly code: CrudQueryErrorCode;
	readonly parameter: string | undefined;

	constructor(
		code: CrudQueryErrorCode,
		message: string,
		options: CrudQueryValidationErrorOptions = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "CrudQueryValidationError";
		this.code = code;
		this.parameter = options.parameter;
	}
}
