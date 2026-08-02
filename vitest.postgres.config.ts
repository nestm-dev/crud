import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: "@nestm/crud/adapter",
				replacement: new URL("./packages/crud/src/adapter/index.ts", import.meta.url).pathname,
			},
			{
				find: "@nestm/crud/testing",
				replacement: new URL("./packages/crud/src/testing/index.ts", import.meta.url).pathname,
			},
			{
				find: "@nestm/crud",
				replacement: new URL("./packages/crud/src/index.ts", import.meta.url).pathname,
			},
			{
				find: "@nestm/crud-memory",
				replacement: new URL("./packages/crud-memory/src/index.ts", import.meta.url).pathname,
			},
			{
				find: "@nestm/crud-typeorm",
				replacement: new URL("./packages/crud-typeorm/src/index.ts", import.meta.url).pathname,
			},
			{
				find: "@nestm/crud-drizzle",
				replacement: new URL("./packages/crud-drizzle/src/index.ts", import.meta.url).pathname,
			},
			{
				find: "@nestm/crud-prisma",
				replacement: new URL("./packages/crud-prisma/src/index.ts", import.meta.url).pathname,
			},
		],
	},
	test: {
		fileParallelism: false,
		include: ["tests/postgres/**/*.spec.ts"],
		maxWorkers: 1,
		setupFiles: ["./tests/setup.ts", "./tests/postgres/require-postgres.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
