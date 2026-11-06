import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import type { SettingValue } from "../protocol/settings.ts";

export function checkSchema<const Schema extends TSchema>(
	schema: Schema,
	value: SettingValue,
): value is SettingValue & Static<Schema> {
	return Check(schema, value);
}
