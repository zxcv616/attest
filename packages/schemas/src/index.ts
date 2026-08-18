import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Resolve to <package root>/src regardless of whether this module is running
// from src (ts-node/tsx during dev) or dist (after `npm run build`) — see
// package.json "files": both directories ship, so "../src" from either
// location lands on the schema files.
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = here.endsWith(`${path.sep}dist`)
  ? path.join(here, "..", "src")
  : here;

export const SCHEMA_NAMES = [
  "common",
  "task",
  "criteriaSet",
  "transaction",
  "replay",
  "evidence",
  "checkpoint",
  "rpc",
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

function loadSchema(name: SchemaName): object {
  const file = path.join(schemaDir, `${name}.schema.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export const schemas: Record<SchemaName, object> = Object.fromEntries(
  SCHEMA_NAMES.map((name) => [name, loadSchema(name)]),
) as Record<SchemaName, object>;

/**
 * A single Ajv instance with every schema pre-registered, so $ref: "common.schema.json#/..."
 * resolves across files without each caller having to know load order.
 */
export function createValidator(): Ajv2020 {
  // strictRequired is disabled: it flags `if/then.required` referencing a
  // property declared in the parent `properties` block (not redeclared
  // inside `then`) as a false positive. That's exactly the shape used by
  // criteriaSet's "behavioral criteria require tolerance" rule.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  addFormats(ajv);
  for (const name of SCHEMA_NAMES) {
    ajv.addSchema(schemas[name], `${name}.schema.json`);
  }
  return ajv;
}

const sharedAjv = createValidator();
const compiled = new Map<SchemaName, ValidateFunction>();

export function validate(name: SchemaName, data: unknown): { valid: boolean; errors: string[] } {
  let fn = compiled.get(name);
  if (!fn) {
    const resolved = sharedAjv.getSchema(`${name}.schema.json`);
    if (!resolved) throw new Error(`Schema not registered: ${name}`);
    fn = resolved;
    compiled.set(name, fn);
  }
  const valid = fn(data) as boolean;
  return { valid, errors: (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

// Re-export the directory listing so a test can assert every *.schema.json
// file on disk is accounted for in SCHEMA_NAMES (catches "added a file,
// forgot to register it").
export function listSchemaFilesOnDisk(): string[] {
  return readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
}
