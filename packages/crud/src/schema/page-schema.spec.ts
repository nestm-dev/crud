import type { StandardSchemaConverter } from "@nestjs/swagger";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createCrudPageSchema, withCrudStandardSchemaConverter } from "./page-schema.ts";

const response = z.object({ id: z.number() });
const converter: StandardSchemaConverter = (schema) =>
	schema === response
		? { schema: { type: "object", properties: { id: { type: "number" } } } }
		: undefined;

describe("createCrudPageSchema", () => {
	it.each([
		[{ offset: true, cursor: false }, "offset"],
		[{ offset: false, cursor: true }, "cursor"],
	] as const)("emits an exact %s page meta schema", (modes, expectedMode) => {
		const schema = createCrudPageSchema(response, modes);
		const converted = withCrudStandardSchemaConverter(converter)(schema, {
			schemaType: "output",
		});

		expect(converted?.schema).toMatchObject({
			properties: {
				meta: {
					properties: { mode: { enum: [expectedMode] } },
					type: "object",
				},
			},
		});
	});

	it("uses a union only for an explicitly dual-mode schema", () => {
		const schema = createCrudPageSchema(response, { offset: true, cursor: true });
		const converted = withCrudStandardSchemaConverter(converter)(schema, {
			schemaType: "output",
		});

		expect(converted?.schema).toMatchObject({
			properties: { meta: { oneOf: expect.any(Array) } },
		});
	});

	it("rejects response metadata from a disabled mode", async () => {
		const schema = createCrudPageSchema(response, { offset: true, cursor: false });
		const result = await schema["~standard"].validate({
			data: [{ id: 1 }],
			meta: { mode: "cursor", limit: 1, nextCursor: null, hasNextPage: false },
		});

		expect(result).toHaveProperty("issues");
	});

	it("lifts an underlying native Standard JSON Schema converter onto the page wrapper", () => {
		const schema = createCrudPageSchema(response, { offset: true, cursor: false });
		if (!("jsonSchema" in schema["~standard"])) {
			throw new TypeError("Expected Zod's native Standard JSON Schema converter.");
		}

		expect(schema["~standard"].jsonSchema.output({ target: "openapi-3.0" })).toMatchObject({
			additionalProperties: false,
			properties: {
				data: { type: "array", items: { type: "object" } },
				meta: { properties: { mode: { enum: ["offset"] } } },
			},
			required: ["data", "meta"],
			type: "object",
		});
	});
});
