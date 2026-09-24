/**
 * A minimal Standard Schema for view-tool arguments.
 *
 * `App.registerTool` takes a Standard Schema and needs two things from it: a
 * `validate` that returns either a value or issues, and a `jsonSchema.input()`
 * that produces the JSON Schema advertised to the host — anything else throws
 * "does not implement Standard JSON Schema".
 *
 * Neither MCP App package depends on zod, and the two view tools take a
 * handful of optional numbers and a boolean between them. Pulling a schema
 * library into two single-file bundles (route-map already ships ~2 MB) to
 * describe that would cost more than it buys, so the shape is built here once
 * and shared. It deliberately covers only flat objects of optional scalars —
 * the moment a view tool needs more than that, take the dependency rather
 * than growing this.
 */

/** One argument of a view tool. */
export type SchemaField =
  | { type: "number"; description: string; minimum?: number }
  | { type: "boolean"; description: string };

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: false;
}

/** The subset of the Standard Schema contract `registerTool` consumes. */
export interface MinimalStandardSchema {
  "~standard": {
    version: 1;
    vendor: string;
    validate: (value: unknown) => { value: unknown } | { issues: Issue[] };
    jsonSchema: {
      input: () => JsonSchemaObject;
      output: () => JsonSchemaObject;
    };
  };
}

interface Issue {
  message: string;
  path?: string[];
}

/**
 * Build a schema for a flat object whose fields are all optional.
 *
 * Every field is optional by design: a view tool is a nudge from the model
 * ("show me 12–18 km", "reset the zoom"), and rejecting a call because one of
 * two interchangeable ways of naming a window was omitted would make it
 * harder to use than the UI it is driving. The handler decides which
 * combinations are meaningful and says so in plain words.
 */
export function optionalObjectSchema(
  fields: Record<string, SchemaField>,
): MinimalStandardSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, field] of Object.entries(fields)) {
    properties[name] =
      field.type === "number"
        ? {
            type: "number",
            description: field.description,
            ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
          }
        : { type: "boolean", description: field.description };
  }

  const jsonSchema: JsonSchemaObject = {
    type: "object",
    properties,
    // No `required`: every field is optional, per the note above.
    additionalProperties: false,
  };

  return {
    "~standard": {
      version: 1,
      vendor: "intervals-mcp",
      validate: (value) => {
        if (value === undefined || value === null) return { value: {} };
        if (typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "expected an object" }] };
        }

        const issues: Issue[] = [];
        const out: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(
          value as Record<string, unknown>,
        )) {
          const field = fields[key];
          if (!field) {
            issues.push({ message: "unknown argument", path: [key] });
            continue;
          }
          if (raw === undefined || raw === null) continue;

          if (field.type === "number") {
            // A host that stringifies numbers is common enough that rejecting
            // "12.5" would be pedantry, not safety.
            const n = typeof raw === "string" ? Number(raw) : raw;
            if (typeof n !== "number" || !Number.isFinite(n)) {
              issues.push({ message: "expected a number", path: [key] });
              continue;
            }
            if (field.minimum !== undefined && n < field.minimum) {
              issues.push({
                message: `must be at least ${field.minimum}`,
                path: [key],
              });
              continue;
            }
            out[key] = n;
          } else {
            if (typeof raw !== "boolean") {
              issues.push({ message: "expected true or false", path: [key] });
              continue;
            }
            out[key] = raw;
          }
        }

        return issues.length > 0 ? { issues } : { value: out };
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}
