import { MemoryCrudAdapter } from "../src/index.ts";

interface UserRecord {
	readonly id: number;
	readonly name: string;
}

export const typedMemoryAdapter = new MemoryCrudAdapter<UserRecord>({
	unique: [["id"], ["name", "id"]],
});

void typedMemoryAdapter.findMany(
	{
		order: [
			{
				// @ts-expect-error query fields are inferred from the record shape.
				field: "email",
				direction: "asc",
			},
		],
		limit: 10,
		count: false,
	},
	{ resource: "users", operation: "list" },
);

export const invalidMemoryFieldAdapter = new MemoryCrudAdapter<UserRecord>({
	unique: [
		[
			// @ts-expect-error unique constraints must use record fields.
			"email",
		],
	],
});

export const emptyMemoryConstraintAdapter = new MemoryCrudAdapter<UserRecord>({
	unique: [
		// @ts-expect-error unique constraints must contain at least one field.
		[],
	],
});
