import { StandardSchemaModule } from "@nestm/standard-schema";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { CrudModule } from "../src/module/crud.module.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { createUserBinding } from "./support/core-fixtures.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

const platforms = [
	["Express", () => new ExpressAdapter()],
	["Fastify", () => new FastifyAdapter()],
] as const;

const idempotentDeleteResource = defineCrudResource({
	fields: ["id", "name"],
	name: "http-idempotent-records",
	path: "api/idempotent-records",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), name: z.string() }),
	},
	operations: { delete: { missing: "ignore" } },
});

function idempotentDeleteBinding() {
	const adapter = new FakeCrudAdapter([{ id: 1, name: "Delete me" }]);
	return defineCrudBinding({
		resource: idempotentDeleteResource,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) => input,
			update: (input) => input,
			response: (record) => ({ id: Number(record.id), name: String(record.name) }),
		},
	});
}

describe.each(platforms)("generated HTTP contract on %s", (_name, createAdapter) => {
	it("serves validated create/list/read/update/delete/restore routes", async () => {
		const binding = createUserBinding(new FakeCrudAdapter());
		const idempotentBinding = idempotentDeleteBinding();
		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot(),
				CrudModule.forFeature({ resources: [binding, idempotentBinding] }),
			],
		}).compile();
		const adapter = createAdapter();
		const app = moduleRef.createNestApplication(adapter, { logger: false });
		await app.init();
		if (adapter instanceof FastifyAdapter) {
			await adapter.getInstance().ready();
		}

		try {
			const invalid = await request(app.getHttpServer())
				.post("/api/users")
				.send({ name: "", tenantId: "tenant-a" })
				.expect(400);
			expect(invalid.body).toMatchObject({ statusCode: 400 });

			const created = await request(app.getHttpServer())
				.post("/api/users")
				.send({ name: "Created", tenantId: "tenant-a" })
				.expect(201);
			expect(created.body).toEqual({
				id: 1,
				name: "Created",
				tenantId: "tenant-a",
				deletedAt: null,
			});

			const listed = await request(app.getHttpServer()).get("/api/users?page=1").expect(200);
			expect(listed.body).toMatchObject({
				data: [{ id: 1, name: "Created", tenantId: "tenant-a", deletedAt: null }],
				meta: { mode: "offset", page: 1, total: 1 },
			});

			await request(app.getHttpServer())
				.get("/api/users/1")
				.expect(200)
				.expect(({ body }) => {
					expect(body).toMatchObject({ id: 1, name: "Created" });
				});
			await request(app.getHttpServer()).get("/api/users/1?garbage=value").expect(400);
			await request(app.getHttpServer())
				.get("/api/users/1?include=children&include=children")
				.expect(400);

			await request(app.getHttpServer())
				.patch("/api/users/1")
				.send({ name: "Updated" })
				.expect(200)
				.expect(({ body }) => {
					expect(body).toMatchObject({ id: 1, name: "Updated" });
				});

			await request(app.getHttpServer()).delete("/api/users/1").expect(204).expect("");
			await request(app.getHttpServer()).get("/api/users/1").expect(404);

			await request(app.getHttpServer())
				.post("/api/users/1/restore")
				.expect(200)
				.expect(({ body }) => {
					expect(body).toMatchObject({ id: 1, name: "Updated", deletedAt: null });
				});
			await request(app.getHttpServer()).get("/api/users/1").expect(200);

			await request(app.getHttpServer()).delete("/api/idempotent-records/1").expect(204);
			await request(app.getHttpServer()).delete("/api/idempotent-records/1").expect(204);
			await request(app.getHttpServer()).delete("/api/idempotent-records/999").expect(204);
		} finally {
			await app.close();
		}
	});
});
