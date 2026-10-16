import { z } from 'zod';

type JsonSchema = {
    type?: string | string[];
    description?: string;
    enum?: unknown[];
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    default?: unknown;
};

/**
 * Best-effort conversion of a JSON Schema (as produced by MCP Gateway tool
 * definitions) into a zod schema, preserving types, descriptions, enums and
 * required/optional flags. Anything unrecognized degrades to z.unknown().
 */
export function jsonSchemaToZod(schema: unknown): z.ZodType {
    return convert((schema || {}) as JsonSchema);
}

function convert(schema: JsonSchema): z.ZodType {

    let type: z.ZodType;

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        const literals = schema.enum.map(value => z.literal(value as z.core.util.Literal));
        type = literals.length === 1 ? literals[0] : z.union(literals);
    } else {
        switch (Array.isArray(schema.type) ? schema.type[0] : schema.type) {
            case 'string':
                type = z.string();
                break;
            case 'number':
                type = z.number();
                break;
            case 'integer':
                type = z.number().int();
                break;
            case 'boolean':
                type = z.boolean();
                break;
            case 'array':
                type = z.array(schema.items ? convert(schema.items) : z.unknown());
                break;
            case 'object': {
                const shape: Record<string, z.ZodType> = {};
                const required = new Set(schema.required || []);
                for (const [key, property] of Object.entries(schema.properties || {})) {
                    const propertyType = convert(property);
                    shape[key] = required.has(key) ? propertyType : propertyType.optional();
                }
                // Loose: gateway tools may accept parameters the schema does not declare.
                type = z.looseObject(shape);
                break;
            }
            default:
                type = z.unknown();
        }
    }

    if (schema.description) {
        type = type.describe(schema.description);
    }
    return type;
}
