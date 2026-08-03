type SwaggerUiStateUpdater<Value> = (value: Value | ((current: Value) => Value)) => void;

interface SwaggerUiReact {
	readonly Fragment: unknown;
	readonly createElement: (
		type: unknown,
		props: Readonly<Record<string, unknown>> | null,
		...children: readonly unknown[]
	) => unknown;
	readonly useState: <Value>(initial: Value) => readonly [Value, SwaggerUiStateUpdater<Value>];
}

interface SwaggerUiMap {
	readonly get: (key: string) => unknown;
}

interface SwaggerUiList {
	readonly filter: (predicate: (value: SwaggerUiMap) => boolean) => SwaggerUiList;
	readonly toArray: () => readonly SwaggerUiMap[];
}

interface SwaggerUiParametersProps extends Readonly<Record<string, unknown>> {
	readonly operation: SwaggerUiMap;
	readonly parameters: SwaggerUiList;
	readonly pathMethod: readonly [string, string];
	readonly specActions: {
		readonly changeParam: (
			pathMethod: readonly [string, string],
			parameterName: string,
			parameterLocation: "query",
			value: string | undefined,
		) => void;
	};
	readonly tryItOutEnabled?: boolean;
	readonly onResetClick?: (...arguments_: unknown[]) => unknown;
	readonly onCancelClick?: (...arguments_: unknown[]) => unknown;
}

interface SwaggerUiSystem {
	readonly React: SwaggerUiReact;
}

interface CrudSwaggerUiPluginDefinition {
	readonly wrapComponents: {
		readonly parameters: (Original: unknown) => (props: SwaggerUiParametersProps) => unknown;
	};
}

/**
 * Optional Swagger UI condition builder for generated CRUD list routes.
 *
 * Nest serializes this function into the browser with `Function#toString`, so
 * every runtime helper intentionally lives inside the function body.
 */
export function NestMCrudQuerySwaggerUiPlugin(
	system: SwaggerUiSystem,
): CrudSwaggerUiPluginDefinition {
	const React = system.React;
	const extensionName = "x-nestm-crud-query";

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function toPlain(value: unknown): unknown {
		if (!isRecord(value) || typeof value.toJS !== "function") return value;
		return value.toJS();
	}

	function readExtension(operation: SwaggerUiMap):
		| {
				readonly conditions: readonly {
					readonly field: string;
					readonly operator: string;
					readonly parameter: string;
					readonly valueKind: "scalar" | "csv-list" | "csv-pair" | "boolean";
				}[];
		  }
		| undefined {
		const value = toPlain(operation.get(extensionName));
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			value.conjunction !== "and" ||
			!Array.isArray(value.conditions) ||
			value.conditions.length === 0
		) {
			return undefined;
		}
		const conditions: Array<{
			readonly field: string;
			readonly operator: string;
			readonly parameter: string;
			readonly valueKind: "scalar" | "csv-list" | "csv-pair" | "boolean";
		}> = [];
		const pairs = new Set<string>();
		const parameters = new Set<string>();
		for (const item of value.conditions) {
			if (
				!isRecord(item) ||
				typeof item.field !== "string" ||
				item.field.length === 0 ||
				typeof item.operator !== "string" ||
				item.operator.length === 0 ||
				typeof item.parameter !== "string" ||
				item.parameter.length === 0 ||
				!(
					item.valueKind === "scalar" ||
					item.valueKind === "csv-list" ||
					item.valueKind === "csv-pair" ||
					item.valueKind === "boolean"
				)
			) {
				return undefined;
			}
			const pair = `${item.field}\u0000${item.operator}`;
			if (pairs.has(pair) || parameters.has(item.parameter)) return undefined;
			pairs.add(pair);
			parameters.add(item.parameter);
			conditions.push({
				field: item.field,
				operator: item.operator,
				parameter: item.parameter,
				valueKind: item.valueKind,
			});
		}
		return { conditions };
	}

	function parameterNames(parameters: SwaggerUiList): readonly string[] {
		return parameters
			.toArray()
			.filter((parameter) => parameter.get("in") === "query")
			.map((parameter) => parameter.get("name"))
			.filter((name): name is string => typeof name === "string");
	}

	function extensionMatchesParameters(
		conditions: readonly { readonly parameter: string }[],
		parameters: SwaggerUiList,
	): boolean {
		const names = parameterNames(parameters);
		return conditions.every(
			(condition) => names.filter((name) => name === condition.parameter).length === 1,
		);
	}

	function operatorLabel(operator: string): string {
		const labels: Readonly<Record<string, string>> = {
			eq: "equals",
			ne: "does not equal",
			gt: "greater than",
			gte: "greater than or equal",
			lt: "less than",
			lte: "less than or equal",
			in: "is one of",
			nin: "is not one of",
			contains: "contains",
			icontains: "contains (case-insensitive)",
			isnull: "is null",
			between: "is between",
		};
		return labels[operator] ?? operator;
	}

	function valuePlaceholder(valueKind: string): string {
		if (valueKind === "csv-list") return "value1,value2,...";
		if (valueKind === "csv-pair") return "minimum,maximum";
		return "value";
	}

	function CrudParameters(props: SwaggerUiParametersProps, Original: unknown): unknown {
		const extension = readExtension(props.operation);
		if (
			extension === undefined ||
			!extensionMatchesParameters(extension.conditions, props.parameters)
		) {
			return React.createElement(Original, props);
		}
		const activeExtension = extension;

		type Row = {
			readonly id: number;
			readonly field: string;
			readonly operator: string;
			readonly value: string;
		};
		const emptyRow = (id: number): Row => ({ id, field: "", operator: "", value: "" });
		const [rows, setRows] = React.useState<readonly Row[]>([emptyRow(1)]);
		const managedNames = new Set(
			activeExtension.conditions.map((condition) => condition.parameter),
		);
		const visibleParameters = props.parameters.filter((parameter) => {
			const name = parameter.get("name");
			return typeof name !== "string" || !managedNames.has(name);
		});

		function selectedCondition(row: Row) {
			return activeExtension.conditions.find(
				(condition) => condition.field === row.field && condition.operator === row.operator,
			);
		}

		function project(nextRows: readonly Row[]): void {
			for (const condition of activeExtension.conditions) {
				props.specActions.changeParam(props.pathMethod, condition.parameter, "query", undefined);
			}
			const projected = new Set<string>();
			for (const row of nextRows) {
				const condition = selectedCondition(row);
				if (condition === undefined || row.value === "" || projected.has(condition.parameter)) {
					continue;
				}
				projected.add(condition.parameter);
				props.specActions.changeParam(props.pathMethod, condition.parameter, "query", row.value);
			}
		}

		function commit(nextRows: readonly Row[]): void {
			setRows(nextRows);
			project(nextRows);
		}

		function updateRow(id: number, update: Partial<Omit<Row, "id">>): readonly Row[] {
			return rows.map((row) => (row.id === id ? { ...row, ...update } : row));
		}

		function addRow(): void {
			if (rows.length >= activeExtension.conditions.length) return;
			const nextId = rows.reduce((maximum, row) => Math.max(maximum, row.id), 0) + 1;
			commit([...rows, emptyRow(nextId)]);
		}

		function removeRow(id: number): void {
			const nextRows =
				rows.length === 1 ? [emptyRow(rows[0]?.id ?? 1)] : rows.filter((row) => row.id !== id);
			commit(nextRows);
		}

		function resetRows(): void {
			commit([emptyRow(1)]);
		}

		function callAfterReset(
			callback: ((...arguments_: unknown[]) => unknown) | undefined,
			arguments_: unknown[],
		): unknown {
			resetRows();
			return callback?.(...arguments_);
		}

		const original = React.createElement(Original, {
			...props,
			parameters: visibleParameters,
			onResetClick: (...arguments_: unknown[]) => callAfterReset(props.onResetClick, arguments_),
			onCancelClick: (...arguments_: unknown[]) => callAfterReset(props.onCancelClick, arguments_),
		});

		const fields = [...new Set(activeExtension.conditions.map((condition) => condition.field))];
		const summary = fields
			.map((field) => {
				const operators = activeExtension.conditions
					.filter((condition) => condition.field === field)
					.map((condition) => condition.operator)
					.join(", ");
				return `${field} (${operators})`;
			})
			.join("; ");

		const builderBody = props.tryItOutEnabled
			? React.createElement(
					"div",
					{ className: "nestm-crud-query-rows" },
					...rows.map((row, index) => {
						const usedPairs = new Set(
							rows
								.filter((candidate) => candidate.id !== row.id)
								.map((candidate) => `${candidate.field}\u0000${candidate.operator}`),
						);
						const operators = activeExtension.conditions.filter(
							(condition) =>
								condition.field === row.field &&
								!usedPairs.has(`${condition.field}\u0000${condition.operator}`),
						);
						const condition = selectedCondition(row);
						const valueControl =
							condition?.valueKind === "boolean"
								? React.createElement(
										"select",
										{
											"aria-label": `Filter value ${String(index + 1)}`,
											className: "nestm-crud-query-control",
											value: row.value,
											disabled: condition === undefined,
											onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
												commit(updateRow(row.id, { value: event.currentTarget.value })),
										},
										React.createElement("option", { value: "" }, "Choose value"),
										React.createElement("option", { value: "true" }, "true"),
										React.createElement("option", { value: "false" }, "false"),
									)
								: React.createElement("input", {
										"aria-label": `Filter value ${String(index + 1)}`,
										className: "nestm-crud-query-control",
										type: "text",
										value: row.value,
										disabled: condition === undefined,
										placeholder:
											condition === undefined
												? "Choose an operator"
												: valuePlaceholder(condition.valueKind),
										onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
											commit(updateRow(row.id, { value: event.currentTarget.value })),
									});
						return React.createElement(
							"div",
							{ className: "nestm-crud-query-row", key: row.id },
							React.createElement(
								"span",
								{ className: "nestm-crud-query-conjunction" },
								index === 0 ? "WHERE" : "AND",
							),
							React.createElement(
								"select",
								{
									"aria-label": `Filter field ${String(index + 1)}`,
									className: "nestm-crud-query-control",
									value: row.field,
									onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
										commit(
											updateRow(row.id, {
												field: event.currentTarget.value,
												operator: "",
												value: "",
											}),
										),
								},
								React.createElement("option", { value: "" }, "Choose field"),
								...fields.map((field) =>
									React.createElement("option", { key: field, value: field }, field),
								),
							),
							React.createElement(
								"select",
								{
									"aria-label": `Filter operator ${String(index + 1)}`,
									className: "nestm-crud-query-control",
									value: row.operator,
									disabled: row.field === "",
									onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
										commit(
											updateRow(row.id, {
												operator: event.currentTarget.value,
												value: "",
											}),
										),
								},
								React.createElement("option", { value: "" }, "Choose operator"),
								...operators.map((candidate) =>
									React.createElement(
										"option",
										{ key: candidate.operator, value: candidate.operator },
										`${candidate.operator} — ${operatorLabel(candidate.operator)}`,
									),
								),
							),
							valueControl,
							React.createElement(
								"button",
								{
									type: "button",
									className: "btn nestm-crud-query-button",
									"aria-label": "Add filter condition",
									title: "Add filter condition",
									disabled: rows.length >= activeExtension.conditions.length,
									onClick: addRow,
								},
								"+",
							),
							React.createElement(
								"button",
								{
									type: "button",
									className: "btn nestm-crud-query-button",
									"aria-label": `Remove filter condition ${String(index + 1)}`,
									title: "Remove filter condition",
									onClick: () => removeRow(row.id),
								},
								"−",
							),
						);
					}),
				)
			: React.createElement(
					"p",
					{ className: "nestm-crud-query-summary" },
					`Available filters: ${summary}. Select “Try it out” to build conditions.`,
				);

		return React.createElement(
			React.Fragment,
			null,
			original,
			React.createElement(
				"section",
				{ className: "opblock-section nestm-crud-query-builder" },
				React.createElement(
					"div",
					{ className: "opblock-section-header nestm-crud-query-header" },
					React.createElement("h4", null, "Filter conditions"),
					React.createElement("span", null, "All conditions use AND"),
				),
				builderBody,
			),
		);
	}

	return {
		wrapComponents: {
			parameters: (Original) => (props) => CrudParameters(props, Original),
		},
	};
}

export const NESTM_CRUD_SWAGGER_UI_CSS = `
.swagger-ui .nestm-crud-query-builder {
  border-top: 1px solid rgba(59, 65, 81, 0.2);
}
.swagger-ui .nestm-crud-query-header {
  align-items: center;
  display: flex;
  gap: 12px;
  justify-content: space-between;
}
.swagger-ui .nestm-crud-query-header h4 {
  margin: 0;
}
.swagger-ui .nestm-crud-query-header span,
.swagger-ui .nestm-crud-query-summary {
  color: #6b7280;
  font-size: 12px;
}
.swagger-ui .nestm-crud-query-summary {
  margin: 0;
  padding: 16px 20px;
}
.swagger-ui .nestm-crud-query-rows {
  display: grid;
  gap: 10px;
  padding: 16px 20px;
}
.swagger-ui .nestm-crud-query-row {
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-columns: 58px minmax(120px, 1fr) minmax(190px, 1.4fr) minmax(180px, 1.5fr) 36px 36px;
}
.swagger-ui .nestm-crud-query-conjunction {
  color: #4b5563;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.swagger-ui .nestm-crud-query-control {
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  box-sizing: border-box;
  min-height: 36px;
  min-width: 0;
  padding: 7px 9px;
  width: 100%;
}
.swagger-ui .nestm-crud-query-control:disabled {
  background: #f3f4f6;
  color: #9ca3af;
}
.swagger-ui .nestm-crud-query-button {
  font-size: 18px;
  height: 36px;
  line-height: 1;
  min-width: 36px;
  padding: 0;
}
@media (max-width: 900px) {
  .swagger-ui .nestm-crud-query-row {
    grid-template-columns: 48px 1fr 1fr;
  }
  .swagger-ui .nestm-crud-query-control:nth-of-type(3) {
    grid-column: 2 / span 2;
  }
}
`;
