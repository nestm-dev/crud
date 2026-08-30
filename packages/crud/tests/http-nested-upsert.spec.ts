import { StandardSchemaModule } from "@nestm/standard-schema";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { CrudModule } from "../src/module/crud.module.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

const platforms = [
	["Express", () => new ExpressAdapter()],
	["Fastify", () => new FastifyAdapter()],
] as const;

const nestedItemResource = defineCrudResource({
	fields: ["projectId", "id", "name"],
	name: "http-nested-items",
	path: "http/projects/:projectId/items",
	itemPath: ":itemId",
	idFields: { projectId: "projectId", itemId: "id" },
	pathParams: {
		contract: z.object({ projectId: z.coerce.number().int().positive() }),
		fields: { projectId: "projectId" },
	},
	contracts: {
		id: z.object({
			projectId: z.coerce.number().int().positive(),
			itemId: z.coerce.number().int().positive(),
		}),
		create: z.object({ id: z.number().int().positive(), name: z.string().min(1) }),
		update: z.object({ name: z.string().min(1).optional() }),
		upsert: z.object({ name: z.string().min(1) }),
		response: z.object({
			projectId: z.number().int().positive(),
			id: z.number().int().positive(),
			name: z.string(),
		}),
	},
	operations: crudOperations.only("create", "list", "read", "upsert"),
	query: {
		sort: { fields: ["id"], default: ["id"] },
		pagination: { offset: true, defaultLimit: 10, maxLimit: 10 },
	},
});

describe.each(platforms)("nested generated HTTP contract on %s", (_name, createAdapter) => {
	it("validates the parent and isolates collection, read, and upsert routes", async () => {
		const adapter = new FakeCrudAdapter([
			{ projectId: 1, id: 1, name: "project one" },
			{ projectId: 2, id: 2, name: "project two" },
		]);
		const binding = defineCrudBinding({
			resource: nestedItemResource,
			adapter: { useValue: adapter },
			scopeCreateFields: ["projectId"],
			upsert: {
				conflictFields: ["projectId", "id"],
				overwriteFields: ["name"],
			},
			mappings: {
				create: (input) => input,
				update: (input) => input,
				upsert: (id, input) => ({ id: id.itemId, name: input.name }),
				persistence: (values) => values,
				response: (record) => ({
					projectId: requiredNumber(record.projectId, "projectId"),
					id: requiredNumber(record.id, "id"),
					name: requiredString(record.name, "name"),
				}),
			},
		});
		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot(),
				CrudModule.forFeature({ resources: [binding] }),
			],
		}).compile();
		const platform = createAdapter();
		const app = moduleRef.createNestApplication(platform, { logger: false });
		await app.init();
		if (platform instanceof FastifyAdapter) await platform.getInstance().ready();

		try {
			await request(app.getHttpServer()).get("/http/projects/not-a-number/items").expect(400);
			await request(app.getHttpServer())
				.put("/http/projects/not-a-number/items/1")
				.send({ name: "invalid parent" })
				.expect(400);

			await request(app.getHttpServer())
				.get("/http/projects/1/items?page=1")
				.expect(200)
				.expect(({ body }) => {
					expect(body.data).toEqual([{ projectId: 1, id: 1, name: "project one" }]);
				});

			await request(app.getHttpServer())
				.post("/http/projects/1/items")
				.send({ id: 3, name: "created under route parent" })
				.expect(201)
				.expect({ projectId: 1, id: 3, name: "created under route parent" });
			await request(app.getHttpServer())
				.get("/http/projects/2/items?page=1")
				.expect(200)
				.expect(({ body }) => {
					expect(body.data).toEqual([{ projectId: 2, id: 2, name: "project two" }]);
				});

			await request(app.getHttpServer())
				.get("/http/projects/1/items/1")
				.expect(200)
				.expect({ projectId: 1, id: 1, name: "project one" });
			await request(app.getHttpServer()).get("/http/projects/2/items/1").expect(404);

			await request(app.getHttpServer())
				.put("/http/projects/2/items/1")
				.send({ name: "upserted in project two" })
				.expect(200)
				.expect({ projectId: 2, id: 1, name: "upserted in project two" });
			await request(app.getHttpServer())
				.put("/http/projects/2/items/1")
				.send({ name: "replaced in project two" })
				.expect(200)
				.expect({ projectId: 2, id: 1, name: "replaced in project two" });

			await request(app.getHttpServer())
				.get("/http/projects/1/items/1")
				.expect(200)
				.expect({ projectId: 1, id: 1, name: "project one" });
			await request(app.getHttpServer())
				.get("/http/projects/2/items/1")
				.expect(200)
				.expect({ projectId: 2, id: 1, name: "replaced in project two" });
			await request(app.getHttpServer())
				.put("/http/projects/2/items/1")
				.send({ name: "" })
				.expect(400);
		} finally {
			await app.close();
		}
	});
});

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number") {
		throw new TypeError(`Fake record field "${field}" must be a number.`);
	}
	return value;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Fake record field "${field}" must be a string.`);
	}
	return value;
}
