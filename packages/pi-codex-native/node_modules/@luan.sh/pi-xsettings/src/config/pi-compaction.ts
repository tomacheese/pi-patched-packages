import { Type } from "typebox";
import type { SettingDefinition, SettingValue } from "../protocol/settings.ts";
import { checkSchema } from "./schema.ts";

const budget = Type.Union([Type.Literal("inherit"), Type.Integer({ minimum: 0 })]);
const schema = Type.Array(
	Type.Object(
		{
			model: Type.String({ pattern: "^[^/]+/.+$" }),
			reserveTokens: budget,
			keepRecentTokens: budget,
		},
		{ additionalProperties: false },
	),
);
const options = (values: number[]) => [
	{ value: "inherit", label: "Use global setting", description: "" },
	...values.map((value) => ({ value, label: String(value), description: "" })),
];

export const compactionModelOverrides: SettingDefinition = {
	key: "compaction.modelOverrides",
	label: "Per-model budgets",
	description: "Override compaction budgets for exact provider/model IDs.",
	category: "behavior",
	section: "Compaction",
	type: "list",
	default: [],
	schema,
	list: {
		itemLabel: "Model",
		identity: "model",
		uniqueIdentity: true,
		minItems: 0,
		summary: [{ path: ["model"] }, { path: ["reserveTokens"] }, { path: ["keepRecentTokens"] }],
		newItem: { model: "", reserveTokens: "inherit", keepRecentTokens: "inherit" },
		fields: [
			{
				key: "model",
				label: "Model",
				description: "Exact provider/model ID.",
				type: "enum",
				options: { source: "models" },
			},
			{
				key: "reserveTokens",
				label: "Response reserve",
				description: "Tokens reserved for the next response.",
				type: "enum",
				options: options([8192, 16384, 32768, 65536]),
			},
			{
				key: "keepRecentTokens",
				label: "Recent tokens",
				description: "Recent tokens kept outside the summary.",
				type: "enum",
				options: options([0, 10000, 20000, 40000, 80000]),
			},
		],
	},
};

/** The UI uses rows; Pi stores the same budgets under exact model IDs. */
export function modelOverrideRows(value: SettingValue): SettingValue[] {
	const rows = Array.isArray(value)
		? value
		: typeof value === "object"
			? Object.entries(value).map(([model, entry]) => {
					if (typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid compaction model override");
					if (Object.keys(entry).some((key) => key !== "reserveTokens" && key !== "keepRecentTokens"))
						throw new Error("Invalid compaction model override fields");
					return { model, reserveTokens: "inherit", keepRecentTokens: "inherit", ...entry };
				})
			: value;
	if (!checkSchema(schema, rows) || new Set(rows.map((row) => row.model)).size !== rows.length)
		throw new Error("Invalid compaction model overrides");
	return rows;
}

export function modelOverrideRecord(value: SettingValue): { [key: string]: SettingValue } {
	const rows = modelOverrideRows(value);
	if (!checkSchema(schema, rows)) throw new Error("Invalid compaction model overrides");
	return Object.fromEntries(
		rows.map(({ model, reserveTokens, keepRecentTokens }) => [
			model,
			{
				...(reserveTokens === "inherit" ? {} : { reserveTokens }),
				...(keepRecentTokens === "inherit" ? {} : { keepRecentTokens }),
			},
		]),
	);
}
