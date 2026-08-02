import { describe, expect, it } from "vitest";

import { assertFixedGroup, assertFixedVersions, resolvePrereleaseTag } from "./publish-state.mjs";

describe("publish state", () => {
	it("accepts a lockstep alpha group", () => {
		expect(
			assertFixedVersions(
				[
					{ name: "a", version: "0.1.0-alpha.0" },
					{ name: "b", version: "0.1.0-alpha.0" },
				],
				{ mode: "pre", tag: "alpha" },
			),
		).toEqual({ version: "0.1.0-alpha.0", tag: "alpha" });
	});

	it("rejects divergent package versions", () => {
		expect(() =>
			assertFixedVersions(
				[
					{ name: "a", version: "0.1.0-alpha.0" },
					{ name: "b", version: "0.1.0-alpha.1" },
				],
				{ mode: "pre", tag: "alpha" },
			),
		).toThrow(/diverged/u);
	});

	it("requires prerelease state and exact fixed membership", () => {
		expect(() => resolvePrereleaseTag("0.1.0-alpha.0", undefined)).toThrow(/pre mode/u);
		expect(assertFixedGroup(["a", "b"], [["b", "a"]])).toEqual(["a", "b"]);
		expect(() => assertFixedGroup(["a"], [["a", "b"]])).toThrow(/does not match/u);
	});
});
