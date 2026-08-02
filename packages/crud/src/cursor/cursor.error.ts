import type { CrudCursorErrorCode } from "./cursor.types.ts";

export class CrudCursorError extends Error {
	readonly code: CrudCursorErrorCode;

	constructor(code: CrudCursorErrorCode, options: ErrorOptions = {}) {
		super("Invalid CRUD cursor.", options);
		this.name = "CrudCursorError";
		this.code = code;
	}
}
