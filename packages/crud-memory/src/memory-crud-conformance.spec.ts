import {
	createCrudAdapterConformanceCases,
	type CrudAdapterConformanceFixture,
} from "@nestm/crud/testing";
import { describe, it } from "vitest";

import { MemoryCrudAdapter } from "./memory-crud-adapter.ts";

type ConformanceRecord = Readonly<Record<string, unknown>>;

function createFixture(): CrudAdapterConformanceFixture<ConformanceRecord> {
	return {
		adapter: new MemoryCrudAdapter<ConformanceRecord>(),
		first: { id: 1, rank: 20 },
		second: { id: 2, rank: 10 },
		update: { rank: 30 },
		idField: "id",
		sortField: "rank",
		expectedAscendingIds: [2, 1],
		getId: (record) => record.id,
	};
}

describe("MemoryCrudAdapter shared conformance", () => {
	for (const testCase of createCrudAdapterConformanceCases<ConformanceRecord>()) {
		it(testCase.name, async () => testCase.run(createFixture()));
	}
});
