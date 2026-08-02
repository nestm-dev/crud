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
		coverage: {
			exclude: ["**/*.config.ts", "**/index.ts"],
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
		include: ["packages/**/*.spec.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
		setupFiles: ["./tests/setup.ts"],
		testTimeout: 15_000,
	},
});
