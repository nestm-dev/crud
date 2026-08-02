import { StandardSchemaModule } from "@nestm/standard-schema";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { CrudModule } from "../src/module/crud.module.ts";
import { createUserBinding } from "./support/core-fixtures.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

const platforms = [
	["Express", () => new ExpressAdapter()],
	["Fastify", () => new FastifyAdapter()],
] as const;

describe.each(platforms)("generated HTTP contract on %s", (_name, createAdapter) => {
	it("serves validated create/list/read/update/delete/restore routes", async () => {
		const binding = createUserBinding(new FakeCrudAdapter());
		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot(),
				CrudModule.forFeature({ resources: [binding] }),
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
		} finally {
			await app.close();
		}
	});
});
