import { CrudAdapterError, type CrudAdapterContext } from "@nestm/crud/adapter";
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

interface SecretEntity {
	readonly tenantId: string;
	readonly id: string;
	name: string;
	secret: string;
	immutable: string;
	profile: {
		nickname: string;
	} | null;
	computed?: string;
}

type SelectedSecretEntity = Pick<SecretEntity, "tenantId" | "id" | "name" | "profile">;

const SELECT = {
	tenantId: true,
	id: true,
	name: true,
	profile: { nickname: true },
} as const satisfies FindOptionsSelect<SecretEntity>;

const COLUMNS = {
	tenantId: "tenantId",
	id: "id",
	name: "name",
	nickname: "profile.nickname",
	secret: "secret",
	immutable: "immutable",
} as const;

const IDENTITY = {
	kind: "and",
	predicates: [
		{ kind: "comparison", field: "tenantId", operator: "eq", value: "tenant-a" },
		{ kind: "comparison", field: "id", operator: "eq", value: "user-1" },
	],
} as const;

const SELECTED_ROW: SelectedSecretEntity = {
	tenantId: "tenant-a",
	id: "user-1",
	name: "Ada",
	profile: { nickname: "ada" },
};

const RETURNED_ROW = {
	tenant_id: "tenant-a",
	id: "user-1",
	display_name: "Grace",
	profile_nickname: "grace",
};

type BuilderOperation = "select" | "insert" | "update" | "delete";

interface WhereCall {
	readonly condition: unknown;
	readonly parameters?: Readonly<Record<string, unknown>>;
}

interface BuilderCapture {
	readonly index: number;
	operation: BuilderOperation;
	selections?: readonly string[];
	readonly andWhere: WhereCall[];
	where?: WhereCall;
	whereIdentity?: Readonly<Record<string, unknown>>;
	order?: readonly [string, string];
	offset?: number;
	limit?: number;
	lock?: string;
	into?: unknown;
	values?: unknown;
	updateValues?: unknown;
	updateEntity?: boolean;
	returning?: readonly string[];
	executions: number;
}

interface ColumnCapture {
	readonly propertyPath: string;
	readonly databaseName: string;
	readonly isVirtual: boolean;
	readonly isVirtualProperty: boolean;
	readonly isUpdate: boolean;
	setEntityValue(record: Record<string, unknown>, value: unknown): void;
}

interface SelectionHarness {
	readonly repository: Repository<SecretEntity>;
	readonly manager: EntityManager;
	readonly builders: BuilderCapture[];
	readonly save: ReturnType<typeof vi.fn>;
	readonly remove: ReturnType<typeof vi.fn>;
	readonly create: ReturnType<typeof vi.fn>;
	readonly merge: ReturnType<typeof vi.fn>;
	readonly prepareHydratedValue: ReturnType<typeof vi.fn>;
}

interface SelectionHarnessOptions {
	readonly getOne?: SelectedSecretEntity | null;
	readonly getMany?: readonly SelectedSecretEntity[];
	readonly total?: number;
	readonly returned?: Readonly<Record<string, unknown>>;
	readonly treeType?: string;
}

function setProperty(record: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let target = record;
	for (const part of parts.slice(0, -1)) {
		const current = target[part];
		if (typeof current === "object" && current !== null && !Array.isArray(current)) {
			target = current as Record<string, unknown>;
		} else {
			const nested: Record<string, unknown> = {};
			target[part] = nested;
			target = nested;
		}
	}
	const leaf = parts.at(-1);
	if (leaf === undefined) throw new Error("A TypeORM property path must not be empty.");
	target[leaf] = value;
}

function createSelectionHarness(options: SelectionHarnessOptions = {}): SelectionHarness {
	const builders: BuilderCapture[] = [];
	const getOne = options.getOne === undefined ? SELECTED_ROW : options.getOne;
	const getMany = options.getMany ?? [SELECTED_ROW];
	const returned = options.returned ?? RETURNED_ROW;
	const save = vi.fn(async () => {
		throw new Error("selected mode must not call Repository.save");
	});
	const remove = vi.fn(async () => {
		throw new Error("selected mode must not call Repository.remove");
	});
	const create = vi.fn((values: object = {}) => ({ constructorDefault: true, ...values }));
	const merge = vi.fn((record: object, values: object) => Object.assign(record, values));
	const prepareHydratedValue = vi.fn((value: unknown, column: ColumnCapture) =>
		column.propertyPath === "name" && typeof value === "string" ? `hydrated:${value}` : value,
	);

	const columns = [
		["tenantId", "tenant_id", false, false, true],
		["id", "id", false, false, true],
		["name", "display_name", false, false, true],
		["secret", "encrypted_secret", false, false, true],
		["immutable", "immutable", false, false, false],
		["profile.nickname", "profile_nickname", false, false, true],
		["computed", "computed", false, true, false],
	] as const;
	const columnByPath = new Map<string, ColumnCapture>(
		columns.map(([propertyPath, databaseName, isVirtual, isVirtualProperty, isUpdate]) => {
			const column: ColumnCapture = {
				propertyPath,
				databaseName,
				isVirtual,
				isVirtualProperty,
				isUpdate,
				setEntityValue: (record, value) => setProperty(record, propertyPath, value),
			};
			return [propertyPath, column];
		}),
	);

	let repository: Repository<SecretEntity>;
	const manager = {
		connection: {
			driver: { prepareHydratedValue },
		},
		getRepository: () => repository,
	} as unknown as EntityManager;

	function createBuilder(): object {
		const capture: BuilderCapture = {
			index: builders.length,
			operation: "select",
			andWhere: [],
			executions: 0,
		};
		builders.push(capture);
		const parameters: Record<string, unknown> = {};
		const builder = {
			alias: TYPEORM_CRUD_ALIAS,
			select(selections: readonly string[]) {
				capture.selections = [...selections];
				return builder;
			},
			andWhere(condition: unknown, values?: Readonly<Record<string, unknown>>) {
				capture.andWhere.push({
					condition,
					...(values === undefined ? {} : { parameters: values }),
				});
				if (values !== undefined) Object.assign(parameters, values);
				if (condition instanceof Brackets) {
					const parameterBuilder = {
						where: (_sql: string, nativeValues?: Readonly<Record<string, unknown>>) => {
							if (nativeValues !== undefined) Object.assign(parameters, nativeValues);
							return parameterBuilder;
						},
						andWhere: (_sql: string, nativeValues?: Readonly<Record<string, unknown>>) => {
							if (nativeValues !== undefined) Object.assign(parameters, nativeValues);
							return parameterBuilder;
						},
					};
					condition.whereFactory(parameterBuilder as never);
				}
				return builder;
			},
			where(condition: unknown, values?: Readonly<Record<string, unknown>>) {
				capture.where = {
					condition,
					...(values === undefined ? {} : { parameters: values }),
				};
				if (values !== undefined) Object.assign(parameters, values);
				return builder;
			},
			andWhereInIds(identity: Readonly<Record<string, unknown>>) {
				capture.whereIdentity = identity;
				Object.assign(parameters, identity);
				return builder;
			},
			addOrderBy(field: string, direction: string) {
				capture.order = [field, direction];
				return builder;
			},
			skip(offset: number) {
				capture.offset = offset;
				return builder;
			},
			take(limit: number) {
				capture.limit = limit;
				return builder;
			},
			limit(limit: number) {
				capture.limit = limit;
				return builder;
			},
			setLock(lock: string) {
				capture.lock = lock;
				return builder;
			},
			async getOne() {
				return getOne;
			},
			async getMany() {
				return [...getMany];
			},
			async getManyAndCount() {
				return [[...getMany], options.total ?? getMany.length] as const;
			},
			insert() {
				capture.operation = "insert";
				return builder;
			},
			into(target: unknown) {
				capture.into = target;
				return builder;
			},
			values(values: unknown) {
				capture.values = values;
				return builder;
			},
			update() {
				capture.operation = "update";
				return builder;
			},
			set(values: unknown) {
				capture.updateValues = values;
				return builder;
			},
			delete() {
				capture.operation = "delete";
				return builder;
			},
			updateEntity(enabled: boolean) {
				capture.updateEntity = enabled;
				return builder;
			},
			returning(fields: readonly string[]) {
				capture.returning = [...fields];
				return builder;
			},
			async execute() {
				capture.executions += 1;
				return { raw: [{ ...returned }], affected: 1 };
			},
			getQuery() {
				return `SELECT_AUTHORIZED_${capture.index}`;
			},
			getParameters() {
				return { ...parameters };
			},
			escape(databaseName: string) {
				return `"${databaseName}"`;
			},
		};
		return builder;
	}

	const metadata = {
		findColumnWithPropertyPath: (path: string) => columnByPath.get(path),
		findColumnWithPropertyPathStrict: (path: string) => columnByPath.get(path),
		findEmbeddedWithPropertyPath: (path: string) =>
			path === "profile" ? { columnsFromTree: [columnByPath.get("profile.nickname")] } : undefined,
		primaryColumns: [columnByPath.get("tenantId"), columnByPath.get("id")],
		treeType: options.treeType,
		getEntityIdMap: (record: Readonly<Partial<SecretEntity>>) =>
			record.tenantId === undefined || record.id === undefined
				? undefined
				: { tenantId: record.tenantId, id: record.id },
		create: () => ({}),
	};

	repository = {
		target: "SecretEntity",
		metadata,
		manager,
		queryRunner: undefined,
		createQueryBuilder: createBuilder,
		create,
		merge,
		save,
		remove,
	} as unknown as Repository<SecretEntity>;

	return {
		repository,
		manager,
		builders,
		save,
		remove,
		create,
		merge,
		prepareHydratedValue,
	};
}

function context(operation: CrudAdapterContext["operation"]): CrudAdapterContext {
	return { resource: "selected-secrets", operation };
}

function selectedAdapter(harness: SelectionHarness) {
	return createTypeOrmCrudAdapter({
		repository: harness.repository,
		columns: COLUMNS,
		select: SELECT,
	});
}

describe("TypeOrmCrudAdapter selected records", () => {
	it("validates non-empty scalar selections and requires the complete primary identity", () => {
		const { repository } = createSelectionHarness();
		const invalidSelections = [
			[{}, "TypeORM CRUD select must include at least one scalar column."],
			[
				{ tenantId: true, id: true, missing: true },
				"TypeORM CRUD select references unknown scalar property 'missing'.",
			],
			[
				{ tenantId: true, id: true, computed: true },
				"TypeORM CRUD select references unknown scalar property 'computed'.",
			],
			[
				{ tenantId: true, id: true, profile: {} },
				"TypeORM CRUD select field 'profile' must include at least one scalar column.",
			],
			[
				{ tenantId: true, id: true, profile: { nickname: false } },
				"TypeORM CRUD select field 'profile' must include at least one scalar column.",
			],
			[{ tenantId: true, name: true }, "TypeORM CRUD select must include primary property 'id'."],
			[
				{ tenantId: true, id: true, name: "yes" },
				"TypeORM CRUD select field 'name' must be true or nested.",
			],
		] as const;

		for (const [select, message] of invalidSelections) {
			expect(() =>
				createTypeOrmCrudAdapter({
					repository,
					columns: COLUMNS,
					select: select as FindOptionsSelect<SecretEntity>,
				}),
			).toThrow(message);
		}
	});

	it("rejects selected mode for TypeORM tree entities", () => {
		const { repository } = createSelectionHarness({ treeType: "closure-table" });
		expect(() =>
			createTypeOrmCrudAdapter({ repository, columns: COLUMNS, select: SELECT }),
		).toThrow("TypeORM CRUD selected records do not support tree entities.");
	});

	it("selects only configured columns for single and collection reads", async () => {
		const harness = createSelectionHarness({
			getMany: [SELECTED_ROW, { ...SELECTED_ROW, id: "user-2", name: "Grace" }],
		});
		const adapter = selectedAdapter(harness);

		const one = await adapter.findOne({ predicate: IDENTITY }, context("read"));
		const many = await adapter.findMany(
			{
				predicate: IDENTITY,
				order: [{ field: "name", direction: "asc" }],
				offset: 4,
				limit: 2,
				count: false,
			},
			context("list"),
		);

		const expectedSelections = [
			`${TYPEORM_CRUD_ALIAS}.tenantId`,
			`${TYPEORM_CRUD_ALIAS}.id`,
			`${TYPEORM_CRUD_ALIAS}.name`,
			`${TYPEORM_CRUD_ALIAS}.profile.nickname`,
		];
		expect(harness.builders).toHaveLength(2);
		expect(harness.builders.map((builder) => builder.selections)).toEqual([
			expectedSelections,
			expectedSelections,
		]);
		expect(harness.builders[1]).toMatchObject({
			order: [`${TYPEORM_CRUD_ALIAS}.name`, "ASC"],
			offset: 4,
			limit: 2,
		});
		expect(one).toEqual(SELECTED_ROW);
		expect(many.records).toHaveLength(2);
		expect(one).not.toHaveProperty("secret");
		expect(many.records[0]).not.toHaveProperty("secret");
	});

	it("creates with primitive INSERT, a narrow RETURNING list, and hydrated values", async () => {
		const harness = createSelectionHarness();
		const adapter = selectedAdapter(harness);

		const created = await adapter.create(
			{
				values: {
					tenantId: "tenant-a",
					id: "user-1",
					name: "Grace",
					secret: "ciphertext",
					profile: { nickname: "grace" },
				},
			},
			context("create"),
		);

		expect(harness.builders).toHaveLength(1);
		expect(harness.builders[0]).toMatchObject({
			operation: "insert",
			into: "SecretEntity",
			values: expect.objectContaining({ constructorDefault: true, secret: "ciphertext" }),
			updateEntity: false,
			returning: ["tenantId", "id", "name", "profile.nickname"],
			executions: 1,
		});
		expect(created).toEqual({
			tenantId: "tenant-a",
			id: "user-1",
			name: "hydrated:Grace",
			profile: { nickname: "grace" },
		});
		expect(harness.prepareHydratedValue).toHaveBeenCalledTimes(4);
		expect(harness.create).toHaveBeenCalledOnce();
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.remove).not.toHaveBeenCalled();
	});

	it("fails closed when TypeORM omits a selected RETURNING column", async () => {
		const harness = createSelectionHarness({
			returned: {
				tenant_id: "tenant-a",
				id: "user-1",
				display_name: "Grace",
			},
		});
		const adapter = selectedAdapter(harness);

		await expect(
			adapter.create(
				{
					values: {
						tenantId: "tenant-a",
						id: "user-1",
						name: "Grace",
						secret: "ciphertext",
					},
				},
				context("create"),
			),
		).rejects.toMatchObject({ code: "unknown" } satisfies Partial<CrudAdapterError>);
	});

	it("updates through direct DML and authorizes its subquery with identity and predicates", async () => {
		const harness = createSelectionHarness();
		const rowPredicate = vi.fn(
			(_predicateContext: TypeOrmCrudRowPredicateContext<SecretEntity>) =>
				new Brackets((query) =>
					query.where(`${TYPEORM_CRUD_ALIAS}.tenantId = :nativeTenant`, {
						nativeTenant: "tenant-a",
					}),
				),
		);
		const adapter = createTypeOrmCrudAdapter({
			repository: harness.repository,
			columns: COLUMNS,
			select: SELECT,
			transactionRunner: {
				run: (_runnerContext, work) => work(harness.manager),
			},
			rowPredicate,
		});

		const updated = await adapter.update(
			{ predicate: IDENTITY, values: { name: "Grace" } },
			context("update"),
		);

		expect(harness.builders).toHaveLength(3);
		const [prior, selector, mutation] = harness.builders;
		expect(prior).toMatchObject({
			selections: [
				`${TYPEORM_CRUD_ALIAS}.tenantId`,
				`${TYPEORM_CRUD_ALIAS}.id`,
				`${TYPEORM_CRUD_ALIAS}.name`,
				`${TYPEORM_CRUD_ALIAS}.profile.nickname`,
			],
			lock: "pessimistic_write",
		});
		expect(selector).toMatchObject({
			selections: [`${TYPEORM_CRUD_ALIAS}.tenantId`, `${TYPEORM_CRUD_ALIAS}.id`],
			whereIdentity: { tenantId: "tenant-a", id: "user-1" },
			limit: 1,
		});
		expect(selector?.andWhere.some(({ condition }) => condition instanceof Brackets)).toBe(true);
		expect(mutation).toMatchObject({
			operation: "update",
			updateValues: { name: "Grace" },
			updateEntity: false,
			returning: ["tenantId", "id", "name", "profile.nickname"],
			executions: 1,
		});
		expect(mutation?.where?.condition).toBe(
			`("tenant_id", "id") IN (SELECT_AUTHORIZED_${selector?.index})`,
		);
		expect(rowPredicate).toHaveBeenCalledTimes(2);
		expect(updated?.name).toBe("hydrated:Grace");
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.remove).not.toHaveBeenCalled();
	});

	it("deletes through direct DML and returns the hydrated narrow record", async () => {
		const harness = createSelectionHarness();
		const adapter = selectedAdapter(harness);

		const deleted = await adapter.delete({ predicate: IDENTITY }, context("delete"));

		expect(harness.builders).toHaveLength(3);
		const mutation = harness.builders[2];
		expect(mutation).toMatchObject({
			operation: "delete",
			returning: ["tenantId", "id", "name", "profile.nickname"],
			executions: 1,
		});
		expect(mutation?.where?.condition).toContain("IN (SELECT_AUTHORIZED_1)");
		expect(deleted).toEqual({
			tenantId: "tenant-a",
			id: "user-1",
			name: "hydrated:Grace",
			profile: { nickname: "grace" },
		});
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.remove).not.toHaveBeenCalled();
	});

	it("returns the selected prior record for ineffective updates without issuing DML", async () => {
		const harness = createSelectionHarness();
		const adapter = selectedAdapter(harness);

		for (const values of [
			{},
			{ name: undefined },
			{ profile: {} },
			{ immutable: "cannot-change" },
		] as const) {
			await expect(
				adapter.update(
					{ predicate: IDENTITY, values: values as DeepPartial<SecretEntity> },
					context("update"),
				),
			).resolves.toEqual(SELECTED_ROW);
		}
		expect(harness.builders).toHaveLength(4);
		expect(harness.builders.every((builder) => builder.operation === "select")).toBe(true);
		expect(harness.builders.every((builder) => builder.executions === 0)).toBe(true);
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.remove).not.toHaveBeenCalled();
	});

	it("expands a nullable embedded root into scalar null assignments", async () => {
		const harness = createSelectionHarness();
		const adapter = selectedAdapter(harness);

		await adapter.update({ predicate: IDENTITY, values: { profile: null } }, context("update"));

		expect(harness.builders[2]).toMatchObject({
			operation: "update",
			updateValues: { profile: { nickname: null } },
			executions: 1,
		});
	});

	it("rejects native row predicates that collide with reserved CRUD parameters", async () => {
		const harness = createSelectionHarness();
		const adapter = createTypeOrmCrudAdapter({
			repository: harness.repository,
			columns: COLUMNS,
			select: SELECT,
			transactionRunner: { run: (_runnerContext, work) => work(harness.manager) },
			rowPredicate: () =>
				new Brackets((query) =>
					query.where(`${TYPEORM_CRUD_ALIAS}.tenantId = :crud_0`, { crud_0: "native" }),
				),
		});

		await expect(adapter.findOne({ predicate: IDENTITY }, context("read"))).rejects.toMatchObject({
			code: "unknown",
		} satisfies Partial<CrudAdapterError>);
		expect(harness.builders[0]?.executions).toBe(0);
	});

	it("reads selected logical fields and rejects access to an omitted one", () => {
		const harness = createSelectionHarness();
		const adapter = selectedAdapter(harness);

		expect(adapter.getField(SELECTED_ROW, "nickname")).toBe("ada");
		expect(() => adapter.getField(SELECTED_ROW, "secret")).toThrowError(
			expect.objectContaining({ code: "unsupported" } satisfies Partial<CrudAdapterError>),
		);
	});
});
