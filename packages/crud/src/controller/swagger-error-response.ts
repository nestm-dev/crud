import type { ApiResponseOptions } from "@nestjs/swagger";

const NEST_ERROR_NAMES = {
	400: "Bad Request",
	404: "Not Found",
	409: "Conflict",
	422: "Unprocessable Entity",
	500: "Internal Server Error",
} as const;

export type CrudSwaggerErrorStatus = keyof typeof NEST_ERROR_NAMES;

type SwaggerResponseSchema = Extract<ApiResponseOptions, { readonly schema: unknown }>["schema"];

/** OpenAPI schema for the native Nest built-in HTTP exception response body. */
export function createNestErrorResponseSchema(
	status: CrudSwaggerErrorStatus,
): SwaggerResponseSchema {
	return {
		additionalProperties: false,
		properties: {
			statusCode: { type: "integer", enum: [status] },
			message: {
				oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			},
			error: { type: "string", enum: [NEST_ERROR_NAMES[status]] },
		},
		required: ["statusCode", "message", "error"],
		type: "object",
	};
}
