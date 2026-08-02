import { describe, expect, it } from "vitest";

import { CrudAdapterError, isCrudAdapterError } from "../src/adapter/adapter.error.ts";

describe("isCrudAdapterError", () => {
	it("recognizes local and structurally equivalent duplicated-package errors", () => {
		expect(isCrudAdapterError(new CrudAdapterError("conflict", "local"))).toBe(true);
		expect(
			isCrudAdapterError({
				name: "CrudAdapterError",
				code: "constraint",
				message: "from another package copy",
				retryable: false,
			}),
		).toBe(true);
	});

	it("rejects incomplete and unrelated error-shaped values", () => {
		expect(isCrudAdapterError(new Error("ordinary"))).toBe(false);
		expect(isCrudAdapterError({ code: "conflict", message: "unbranded" })).toBe(false);
		expect(
			isCrudAdapterError({
				name: "CrudAdapterError",
				code: "not-a-code",
				message: "invalid",
				retryable: false,
			}),
		).toBe(false);
	});
});
