import { CrudAdapterError } from "@nestm/crud/adapter";
import { describe, expect, it, vi } from "vitest";

import { createPrismaCrudAdapter } from "../src/prisma-adapter.ts";

interface User {
	readonly id: number;
	readonly name: string;
}

function context(operation: "read" | "create" = "read") {
	return { resource: "users", operation } as const;
}

describe("PrismaCrudAdapter", () => {
	it("uses the consumer transaction and its narrowed delegate", async () => {
		const transactionalUser = { id: 1, name: "transactional" };
		const transactionDelegate = {
			create: vi.fn(async () => transactionalUser),
		};
		const client = {
			user: { create: vi.fn() },
			$transaction: async <Result>(work: (transaction: unknown) => Promise<Result>) =>
				work({ user: transactionDelegate }),
		};
		const adapter = createPrismaCrudAdapter<User, typeof client, typeof transactionDelegate>({
			client,
			delegate: (owner) => owner.user as typeof transactionDelegate,
			identity: (record) => ({ id: record.id }),
		});

		const result = await adapter.transaction(
			(session) => adapter.create({ values: { name: "x" } }, { ...context("create"), session }),
			context("create"),
		);

		expect(result).toEqual(transactionalUser);
		expect(transactionDelegate.create).toHaveBeenCalledWith({ data: { name: "x" } });
	});

	it("sanitizes known unique failures", async () => {
		const client = {
			user: {
				create: vi.fn(async () => Promise.reject({ code: "P2002", meta: { target: "email" } })),
			},
			$transaction: vi.fn(),
		};
		const adapter = createPrismaCrudAdapter<User, typeof client, typeof client.user>({
			client,
			delegate: (owner) => owner.user,
			identity: (record) => ({ id: record.id }),
		});

		await expect(adapter.create({ values: {} }, context("create"))).rejects.toMatchObject({
			code: "conflict",
			message: "A record with the same unique values already exists.",
		} satisfies Partial<CrudAdapterError>);
	});
});
