import {
	CrudAdapterError,
	type CrudAdapterContext,
	type CrudUpsertInput,
} from "@nestm/crud/adapter";
import {
	Brackets,
	type DeepPartial,
	type EntityManager,
	type FindOptionsSelect,
	type Repository,
} from "typeorm";
import { describe, expect, it, vi } from "vitest";

import {
	createTypeOrmCrudAdapter,
	TYPEORM_CRUD_ALIAS,
	type TypeOrmCrudRowPredicateContext,
} from "../src/index.ts";

interface UpsertEntity {
	readonly tenantId: string;
	readonly id: string;
	name: string;
	secret: string;
	immutable: string;
}

const COLUMNS = {
	tenantId: "tenantId",
	id: "id",
	name: "name",
	secret: "secret",
	immutable: "immutable",
} as const;

const SELECT = {
	tenantId: true,
	id: true,
	name: true,
} as const satisfies FindOptionsSelect<UpsertEntity>;

const PREDICATE = {
	kind: "and",
	predicates: [
		{ kind: "comparison", field: "tenantId", operator: "eq", value: "tenant-a" },
		{ kind: "comparison", field: "id", operator: "eq", value: "item-1" },
	],
} as const;

const UPSERT_INPUT = {
	conflictFields: ["tenantId", "id"],
	predicate: PREDICATE,
	values: {
		tenantId: "tenant-a",
		id: "item-1",
		name: "Grace",
		secret: "ciphertext",
		immutable: "fixed",
	},
	overwriteFields: ["name"],
} as const satisfies CrudUpsertInput<DeepPartial<UpsertEntity>>;

const UNIQUE_UPSERT_INPUT = {
	conflictFields: ["tenantId", "immutable"],
	predicate: {
		kind: "and",
		predicates: [
			{ kind: "comparison", field: "tenantId", operator: "eq", value: "tenant-a" },
			{ kind: "comparison", field: "immutable", operator: "eq", value: "fixed" },
		],
	},
	values: {
		tenantId: "tenant-a",
		name: "Grace",
		secret: "ciphertext",
		immutable: "fixed",
	},
	overwriteFields: ["name"],
} as const satisfies CrudUpsertInput<DeepPartial<UpsertEntity>>;

interface ColumnCapture {
	readonly propertyPath: string;
	readonly databaseName: string;
	readonly isPrimary: boolean;
	readonly isInsert: boolean;
	readonly isUpdate: boolean;
	readonly isVirtual: boolean;
	readonly isVirtualProperty: boolean;
	getEntityValue(entity: Readonly<Record<string, unknown>>): unknown;
	setEntityValue(entity: Record<string, unknown>, value: unknown): void;
}

interface UpsertCapture {
	readonly selectors: {
		readonly conditions: unknown[];
		readonly parameters: Readonly<Record<string, unknown>>;
	}[];
	readonly inserts: {
		values?: unknown;
		overwrite?: readonly string[];
		conflict?: readonly string[];
		overwriteCondition?: {
			readonly where: string | Brackets | Readonly<Record<string, unknown>>;
			readonly parameters?: Readonly<Record<string, unknown>>;
		};
		returning?: readonly string[];
		updateEntity?: boolean;
		executions: number;
	}[];
	readonly create: ReturnType<typeof vi.fn>;
	readonly prepareHydratedValue: ReturnType<typeof vi.fn>;
}

interface UpsertHarness {
	readonly repository: Repository<UpsertEntity>;
	readonly manager: EntityManager;
	readonly capture: UpsertCapture;
}

interface UpsertHarnessOptions {
	readonly returned?: readonly Readonly<Record<string, unknown>>[];
	readonly treeType?: string;
	readonly inheritancePattern?: string;
	readonly childEntityCount?: number;
	readonly primaryFields?: readonly Extract<keyof UpsertEntity, string>[];
	readonly uniqueConstraints?: readonly {
		readonly fields: readonly Extract<keyof UpsertEntity, string>[];
		readonly deferrable?: string;
	}[];
	readonly uniqueIndexes?: readonly {
		readonly fields: readonly Extract<keyof UpsertEntity, string>[];
		readonly where?: string;
	}[];
}

function setProperty(target: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let record = target;
	for (const part of parts.slice(0, -1)) {
		const nested: Record<string, unknown> = {};
		record[part] = nested;
		record = nested;
	}
	const leaf = parts.at(-1);
	if (leaf !== undefined) record[leaf] = value;
}

function createUpsertHarness(options: UpsertHarnessOptions = {}): UpsertHarness {
	const selectors: UpsertCapture["selectors"] = [];
	const inserts: UpsertCapture["inserts"] = [];
	const create = vi.fn((values: object) => ({ constructorDefault: true, ...values }));
	const prepareHydratedValue = vi.fn((value: unknown, column: ColumnCapture) =>
		column.propertyPath === "name" ? `hydrated:${String(value)}` : value,
	);
	const primaryFields = new Set(options.primaryFields ?? ["tenantId", "id"]);
	const columnDefinitions = [
		["tenantId", "tenant_id", true, true],
		["id", "id", true, true],
		["name", "display_name", true, true],
		["secret", "secret_ciphertext", true, true],
		["immutable", "immutable_value", true, false],
	] as const;
	const columns = columnDefinitions.map(
		([propertyPath, databaseName, isInsert, isUpdate]): ColumnCapture => ({
			propertyPath,
			databaseName,
			isPrimary: primaryFields.has(propertyPath),
			isInsert,
			isUpdate,
			isVirtual: false,
			isVirtualProperty: false,
			getEntityValue: (entity) => entity[propertyPath],
			setEntityValue: (entity, value) => setProperty(entity, propertyPath, value),
		}),
	);
	const columnByPath = new Map(columns.map((column) => [column.propertyPath, column]));
	const metadataColumns = (fields: readonly Extract<keyof UpsertEntity, string>[]) =>
		fields.map((field) => {
			const column = columnByPath.get(field);
			if (column === undefined) throw new Error(`Unknown harness column '${field}'.`);
			return column;
		});

	let repository: Repository<UpsertEntity>;
	const manager = {
		connection: { driver: { prepareHydratedValue } },
		getRepository: () => repository,
	} as unknown as EntityManager;

	function createQueryBuilder(alias?: string): object {
		const parameters: Record<string, unknown> = {};
		const conditions: unknown[] = [];
		let selectorCapture:
			| {
					readonly conditions: unknown[];
					readonly parameters: Readonly<Record<string, unknown>>;
			  }
			| undefined;
		let insertCapture: UpsertCapture["inserts"][number] | undefined;
		const expressionMap = { mainAlias: { name: alias ?? TYPEORM_CRUD_ALIAS } };
		const builder = {
			alias: alias ?? TYPEORM_CRUD_ALIAS,
			expressionMap,
			select(_selection: string | readonly string[]) {
				selectorCapture = { conditions, parameters };
				selectors.push(selectorCapture);
				return builder;
			},
			andWhere(condition: unknown, values?: Readonly<Record<string, unknown>>) {
				conditions.push(condition);
				if (values !== undefined) Object.assign(parameters, values);
				if (condition instanceof Brackets) {
					const nativeBuilder = {
						where(sql: string, nativeValues?: Readonly<Record<string, unknown>>) {
							conditions.push(sql);
							if (nativeValues !== undefined) Object.assign(parameters, nativeValues);
							return nativeBuilder;
						},
						andWhere(sql: string, nativeValues?: Readonly<Record<string, unknown>>) {
							conditions.push(sql);
							if (nativeValues !== undefined) Object.assign(parameters, nativeValues);
							return nativeBuilder;
						},
					};
					condition.whereFactory(nativeBuilder as never);
				}
				return builder;
			},
			getQuery() {
				if (selectorCapture === undefined) return "INSERT_CAPTURE";
				return `SELECT 1 FROM upsert_entity WHERE ${conditions
					.filter((condition) => typeof condition === "string")
					.join(" AND ")}`;
			},
			getParameters() {
				return { ...parameters };
			},
			insert() {
				insertCapture = { executions: 0 };
				inserts.push(insertCapture);
				return builder;
			},
			into(_target: unknown) {
				return builder;
			},
			values(values: unknown) {
				if (insertCapture !== undefined) insertCapture.values = values;
				return builder;
			},
			orUpdate(
				overwrite: readonly string[],
				conflict: readonly string[],
				orUpdateOptions: {
					readonly overwriteCondition?: {
						readonly where: string | Brackets | Readonly<Record<string, unknown>>;
						readonly parameters?: Readonly<Record<string, unknown>>;
					};
				},
			) {
				if (insertCapture !== undefined) {
					insertCapture.overwrite = [...overwrite];
					insertCapture.conflict = [...conflict];
					if (orUpdateOptions.overwriteCondition !== undefined) {
						insertCapture.overwriteCondition = orUpdateOptions.overwriteCondition;
					}
				}
				return builder;
			},
			updateEntity(enabled: boolean) {
				if (insertCapture !== undefined) insertCapture.updateEntity = enabled;
				return builder;
			},
			returning(propertyPaths: readonly string[]) {
				if (insertCapture !== undefined) insertCapture.returning = [...propertyPaths];
				return builder;
			},
			async execute() {
				if (insertCapture === undefined) throw new Error("expected an insert builder");
				insertCapture.executions += 1;
				return {
					raw: options.returned ?? [
						{
							tenant_id: "tenant-a",
							id: "item-1",
							display_name: "Grace",
							secret_ciphertext: "ciphertext",
							immutable_value: "fixed",
						},
					],
				};
			},
		};
		return builder;
	}

	const metadata = {
		tableName: "upsert_entity",
		columns,
		primaryColumns: columns.filter((column) => column.isPrimary),
		uniques: (options.uniqueConstraints ?? []).map((unique) => ({
			columns: metadataColumns(unique.fields),
			...(unique.deferrable === undefined ? {} : { deferrable: unique.deferrable }),
		})),
		indices: (options.uniqueIndexes ?? []).map((index) => ({
			isUnique: true,
			columns: metadataColumns(index.fields),
			...(index.where === undefined ? {} : { where: index.where }),
		})),
		findColumnWithPropertyPath: (path: string) => columnByPath.get(path),
		findColumnWithPropertyPathStrict: (path: string) => columnByPath.get(path),
		create: () => ({}),
	};
	repository = {
		target: "UpsertEntity",
		metadata: {
			...metadata,
			treeType: options.treeType,
			inheritancePattern: options.inheritancePattern,
			childEntityMetadatas: Array.from({ length: options.childEntityCount ?? 0 }, () => ({})),
		},
		manager,
		queryRunner: undefined,
		create,
		createQueryBuilder,
	} as unknown as Repository<UpsertEntity>;

	return {
		repository,
		manager,
		capture: { selectors, inserts, create, prepareHydratedValue },
	};
}

function context(): CrudAdapterContext {
	return { resource: "upsert-items", operation: "upsert", pathParams: { tenantId: "tenant-a" } };
}

function selectedAdapter(harness: UpsertHarness) {
	return createTypeOrmCrudAdapter({
		repository: harness.repository,
		columns: COLUMNS,
		select: SELECT,
	});
}

describe("TypeOrmCrudAdapter atomic upsert", () => {
	it("uses one insert-on-conflict statement with full primary identity and narrow returning", async () => {
		const harness = createUpsertHarness();
		const rowPredicate = vi.fn(
			(predicateContext: TypeOrmCrudRowPredicateContext<UpsertEntity>) =>
				new Brackets((where) =>
					where.where(`${predicateContext.alias}.tenantId = :nativeTenant`, {
						nativeTenant: "tenant-a",
					}),
				),
		);
		const adapter = createTypeOrmCrudAdapter({
			repository: harness.repository,
			columns: COLUMNS,
			select: SELECT,
			transactionRunner: { run: (_runnerContext, work) => work(harness.manager) },
			rowPredicate,
		});

		const result = await adapter.upsert(UPSERT_INPUT, context());

		expect(harness.capture.selectors).toHaveLength(1);
		expect(harness.capture.inserts).toEqual([
			expect.objectContaining({
				values: expect.objectContaining({ constructorDefault: true, secret: "ciphertext" }),
				overwrite: ["display_name"],
				conflict: ["tenant_id", "id"],
				returning: ["tenantId", "id", "name"],
				updateEntity: false,
				executions: 1,
			}),
		]);
		const condition = harness.capture.inserts[0]?.overwriteCondition;
		expect(condition?.where).toContain(`${TYPEORM_CRUD_ALIAS}.tenantId = :nativeTenant`);
		expect(condition?.where).toContain(`${TYPEORM_CRUD_ALIAS}.tenantId = :crud_0`);
		expect(condition?.where).toContain(`${TYPEORM_CRUD_ALIAS}.id = :crud_1`);
		expect(condition?.parameters).toEqual({
			nativeTenant: "tenant-a",
			crud_0: "tenant-a",
			crud_1: "item-1",
		});
		expect(result).toEqual({ tenantId: "tenant-a", id: "item-1", name: "hydrated:Grace" });
		expect(result).not.toHaveProperty("secret");
		expect(rowPredicate).toHaveBeenCalledWith(
			expect.objectContaining({
				alias: TYPEORM_CRUD_ALIAS,
				context: expect.objectContaining({ pathParams: { tenantId: "tenant-a" } }),
			}),
		);
	});

	it.each(["constraint", "index"] as const)(
		"accepts a complete non-primary unique %s while the generated primary value is absent",
		async (kind) => {
			const unique = { fields: ["tenantId", "immutable"] as const };
			const harness = createUpsertHarness({
				primaryFields: ["id"],
				...(kind === "constraint" ? { uniqueConstraints: [unique] } : { uniqueIndexes: [unique] }),
			});

			const result = await selectedAdapter(harness).upsert(UNIQUE_UPSERT_INPUT, context());

			expect(harness.capture.inserts[0]).toEqual(
				expect.objectContaining({
					conflict: ["tenant_id", "immutable_value"],
					overwrite: ["display_name"],
					values: expect.not.objectContaining({ id: expect.anything() }),
				}),
			);
			expect(result).toMatchObject({ id: "item-1", name: "hydrated:Grace" });
		},
	);

	it("returns null without hydrating when the conflicting row fails authorization", async () => {
		const harness = createUpsertHarness({ returned: [] });
		const result = await selectedAdapter(harness).upsert(UPSERT_INPUT, context());

		expect(result).toBeNull();
		expect(harness.capture.inserts[0]?.executions).toBe(1);
		expect(harness.capture.prepareHydratedValue).not.toHaveBeenCalled();
	});

	it("fails before DML when native authorization reuses a reserved CRUD parameter", async () => {
		const harness = createUpsertHarness();
		const adapter = createTypeOrmCrudAdapter({
			repository: harness.repository,
			columns: COLUMNS,
			select: SELECT,
			transactionRunner: { run: (_runnerContext, work) => work(harness.manager) },
			rowPredicate: ({ alias }) =>
				new Brackets((where) => where.where(`${alias}.tenantId = :crud_0`, { crud_0: "native" })),
		});

		await expect(adapter.upsert(UPSERT_INPUT, context())).rejects.toMatchObject({
			code: "unknown",
		} satisfies Partial<CrudAdapterError>);
		expect(harness.capture.inserts).toHaveLength(0);
	});

	it("uses explicit RETURNING for every scalar column in full-record mode", async () => {
		const harness = createUpsertHarness();
		const adapter = createTypeOrmCrudAdapter({ repository: harness.repository, columns: COLUMNS });

		const result = await adapter.upsert(UPSERT_INPUT, context());

		expect(harness.capture.inserts[0]?.returning).toEqual([
			"tenantId",
			"id",
			"name",
			"secret",
			"immutable",
		]);
		expect(result).toEqual({
			tenantId: "tenant-a",
			id: "item-1",
			name: "hydrated:Grace",
			secret: "ciphertext",
			immutable: "fixed",
		});
	});

	it("rejects partial, duplicated, non-unique, and absent conflict paths before DML", async () => {
		const cases: readonly CrudUpsertInput<DeepPartial<UpsertEntity>>[] = [
			{ ...UPSERT_INPUT, conflictFields: ["tenantId"] },
			{ ...UPSERT_INPUT, conflictFields: ["tenantId", "tenantId"] },
			{ ...UPSERT_INPUT, conflictFields: ["tenantId", "name"] },
			{
				...UPSERT_INPUT,
				values: {
					tenantId: "tenant-a",
					name: "Grace",
					secret: "ciphertext",
					immutable: "fixed",
				},
			},
		];

		for (const input of cases) {
			const harness = createUpsertHarness();
			await expect(selectedAdapter(harness).upsert(input, context())).rejects.toMatchObject({
				code: "unsupported",
			} satisfies Partial<CrudAdapterError>);
			expect(harness.capture.inserts).toHaveLength(0);
		}
	});

	it("rejects deferrable unique constraints and partial unique indexes before DML", async () => {
		const cases: readonly UpsertHarnessOptions[] = [
			{
				primaryFields: ["id"],
				uniqueConstraints: [
					{ fields: ["tenantId", "immutable"], deferrable: "INITIALLY DEFERRED" },
				],
			},
			{
				primaryFields: ["id"],
				uniqueIndexes: [
					{ fields: ["tenantId", "immutable"], where: '"immutable_value" IS NOT NULL' },
				],
			},
		];

		for (const options of cases) {
			const harness = createUpsertHarness(options);
			await expect(
				selectedAdapter(harness).upsert(UNIQUE_UPSERT_INPUT, context()),
			).rejects.toMatchObject({ code: "unsupported" } satisfies Partial<CrudAdapterError>);
			expect(harness.capture.inserts).toHaveLength(0);
		}
	});

	it("rejects primary, immutable, unknown, and duplicated overwrite paths before DML", async () => {
		for (const overwriteFields of [["id"], ["immutable"], ["missing"], ["name", "name"]] as const) {
			const harness = createUpsertHarness();
			await expect(
				selectedAdapter(harness).upsert({ ...UPSERT_INPUT, overwriteFields }, context()),
			).rejects.toMatchObject({ code: "unsupported" } satisfies Partial<CrudAdapterError>);
			expect(harness.capture.inserts).toHaveLength(0);
		}

		const missingValue = createUpsertHarness();
		await expect(
			selectedAdapter(missingValue).upsert(
				{
					...UPSERT_INPUT,
					values: {
						tenantId: "tenant-a",
						id: "item-1",
						secret: "ciphertext",
						immutable: "fixed",
					},
				},
				context(),
			),
		).rejects.toMatchObject({ code: "unsupported" } satisfies Partial<CrudAdapterError>);
		expect(missingValue.capture.inserts).toHaveLength(0);
	});

	it("fails closed for primitive-DML entity models that TypeORM cannot upsert safely", async () => {
		for (const options of [
			{ treeType: "closure-table" },
			{ inheritancePattern: "STI", childEntityCount: 1 },
		] as const) {
			const harness = createUpsertHarness(options);
			const adapter = createTypeOrmCrudAdapter({
				repository: harness.repository,
				columns: COLUMNS,
			});
			await expect(adapter.upsert(UPSERT_INPUT, context())).rejects.toMatchObject({
				code: "unsupported",
			} satisfies Partial<CrudAdapterError>);
			expect(harness.capture.selectors).toHaveLength(0);
			expect(harness.capture.inserts).toHaveLength(0);
		}
	});
});
