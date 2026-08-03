import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { NestMCrudQuerySwaggerUiPlugin, NESTM_CRUD_SWAGGER_UI_CSS } from "./swagger-ui.plugin.ts";

interface ElementNode {
	readonly type: unknown;
	readonly props: Readonly<Record<string, unknown>>;
	readonly children: readonly unknown[];
}

class FakeMap {
	constructor(private readonly values: Readonly<Record<string, unknown>>) {}

	get(key: string): unknown {
		return this.values[key];
	}
}

class FakeList {
	constructor(private readonly values: readonly FakeMap[]) {}

	filter(predicate: (value: FakeMap) => boolean): FakeList {
		return new FakeList(this.values.filter(predicate));
	}

	toArray(): readonly FakeMap[] {
		return this.values;
	}
}

function createReactHarness() {
	const state: unknown[] = [];
	let cursor = 0;
	const React = {
		Fragment: "Fragment",
		createElement(
			type: unknown,
			props: Readonly<Record<string, unknown>> | null,
			...children: readonly unknown[]
		): ElementNode {
			return { type, props: props ?? {}, children };
		},
		useState<Value>(
			initial: Value,
		): readonly [Value, (value: Value | ((current: Value) => Value)) => void] {
			const index = cursor;
			cursor += 1;
			if (index >= state.length) state.push(initial);
			return [
				state[index] as Value,
				(value) => {
					state[index] =
						typeof value === "function"
							? (value as (current: Value) => Value)(state[index] as Value)
							: value;
				},
			];
		},
	};
	return {
		React,
		render<Props>(component: (props: Props) => unknown, props: Props): ElementNode {
			cursor = 0;
			return component(props) as ElementNode;
		},
	};
}

describe("NestM CRUD Swagger UI plugin", () => {
	it("builds AND rows and projects them into the existing formal parameters", () => {
		const harness = createReactHarness();
		const plugin = NestMCrudQuerySwaggerUiPlugin({ React: harness.React });
		const Wrapped = plugin.wrapComponents.parameters("OriginalParameters");
		const changes: Array<{
			readonly name: string;
			readonly value: string | undefined;
		}> = [];
		let resets = 0;
		const props = {
			operation: new FakeMap({
				"x-nestm-crud-query": {
					version: 1,
					conjunction: "and",
					conditions: [
						{
							field: "status",
							operator: "eq",
							parameter: "filter[status][eq]",
							valueKind: "scalar",
						},
						{
							field: "status",
							operator: "in",
							parameter: "filter[status][in]",
							valueKind: "csv-list",
						},
					],
				},
			}),
			parameters: new FakeList([
				new FakeMap({ in: "query", name: "filter[status][eq]" }),
				new FakeMap({ in: "query", name: "filter[status][in]" }),
				new FakeMap({ in: "query", name: "page" }),
			]),
			pathMethod: ["/documents", "get"] as const,
			specActions: {
				changeParam(
					_pathMethod: readonly [string, string],
					name: string,
					_location: "query",
					value: string | undefined,
				): void {
					changes.push({ name, value });
				},
			},
			tryItOutEnabled: true,
			onResetClick: () => {
				resets += 1;
			},
		};
		const typedProps = props as unknown as Parameters<typeof Wrapped>[0];

		let tree = harness.render(Wrapped, typedProps);
		const original = elements(tree).find((element) => element.type === "OriginalParameters");
		if (original === undefined) throw new TypeError("Missing original parameters component.");
		const visibleParameters = original.props.parameters;
		if (!(visibleParameters instanceof FakeList)) {
			throw new TypeError("Original component received an invalid parameter list.");
		}
		expect(visibleParameters.toArray().map((parameter) => parameter.get("name"))).toEqual(["page"]);

		change(select(tree, "Filter field 1"), "status");
		tree = harness.render(Wrapped, typedProps);
		change(select(tree, "Filter operator 1"), "eq");
		tree = harness.render(Wrapped, typedProps);
		change(select(tree, "Filter value 1"), "published");
		expect(changes.at(-1)).toEqual({ name: "filter[status][eq]", value: "published" });

		tree = harness.render(Wrapped, typedProps);
		click(button(tree, "Add filter condition"));
		tree = harness.render(Wrapped, typedProps);
		change(select(tree, "Filter field 2"), "status");
		tree = harness.render(Wrapped, typedProps);
		const secondOperator = select(tree, "Filter operator 2");
		expect(optionValues(secondOperator)).toEqual(["", "in"]);
		change(secondOperator, "in");
		tree = harness.render(Wrapped, typedProps);
		change(select(tree, "Filter value 2"), "draft,published");
		expect(changes.slice(-2)).toEqual([
			{ name: "filter[status][eq]", value: "published" },
			{ name: "filter[status][in]", value: "draft,published" },
		]);

		tree = harness.render(Wrapped, typedProps);
		click(button(tree, "Remove filter condition 2"));
		expect(changes.findLast((changeValue) => changeValue.name === "filter[status][in]")).toEqual({
			name: "filter[status][in]",
			value: undefined,
		});

		tree = harness.render(Wrapped, typedProps);
		const reset = elements(tree).find((element) => element.type === "OriginalParameters")?.props
			.onResetClick;
		expect(typeof reset).toBe("function");
		(reset as () => void)();
		expect(resets).toBe(1);
	});

	it("falls back to the stock component for malformed or stale metadata", () => {
		const harness = createReactHarness();
		const plugin = NestMCrudQuerySwaggerUiPlugin({ React: harness.React });
		const Wrapped = plugin.wrapComponents.parameters("OriginalParameters");
		const props = {
			operation: new FakeMap({
				"x-nestm-crud-query": {
					version: 2,
					conjunction: "and",
					conditions: [],
				},
			}),
			parameters: new FakeList([]),
			pathMethod: ["/documents", "get"] as const,
			specActions: { changeParam: () => undefined },
		};

		const tree = harness.render(Wrapped, props as unknown as Parameters<typeof Wrapped>[0]);
		expect(tree.type).toBe("OriginalParameters");
		expect(elements(tree).some((element) => element.type === "section")).toBe(false);
	});

	it("is self-contained for Nest's browser serialization", () => {
		const serialized = NestMCrudQuerySwaggerUiPlugin.toString();
		const restored = runInNewContext(`(${serialized})`) as typeof NestMCrudQuerySwaggerUiPlugin;
		const harness = createReactHarness();

		expect(restored({ React: harness.React }).wrapComponents.parameters).toBeTypeOf("function");
		expect(NESTM_CRUD_SWAGGER_UI_CSS).toContain(".nestm-crud-query-row");
	});
});

function elements(value: unknown): readonly ElementNode[] {
	if (!isElement(value)) return Array.isArray(value) ? value.flatMap(elements) : [];
	return [value, ...value.children.flatMap(elements)];
}

function isElement(value: unknown): value is ElementNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		"props" in value &&
		"children" in value
	);
}

function select(tree: ElementNode, label: string): ElementNode {
	const element = elements(tree).find(
		(candidate) =>
			(candidate.type === "select" || candidate.type === "input") &&
			candidate.props["aria-label"] === label,
	);
	if (element === undefined) throw new TypeError(`Missing control ${label}.`);
	return element;
}

function button(tree: ElementNode, label: string): ElementNode {
	const element = elements(tree).find(
		(candidate) => candidate.type === "button" && candidate.props["aria-label"] === label,
	);
	if (element === undefined) throw new TypeError(`Missing button ${label}.`);
	return element;
}

function change(element: ElementNode, value: string): void {
	const onChange = element.props.onChange;
	if (typeof onChange !== "function") throw new TypeError("Control has no change handler.");
	onChange({ currentTarget: { value } });
}

function click(element: ElementNode): void {
	const onClick = element.props.onClick;
	if (typeof onClick !== "function") throw new TypeError("Button has no click handler.");
	onClick();
}

function optionValues(selectElement: ElementNode): readonly unknown[] {
	return elements(selectElement)
		.filter((element) => element.type === "option")
		.map((element) => element.props.value);
}
