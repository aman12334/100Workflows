import { ANALYTICS } from "./analytics";
import { FINANCE } from "./finance";
import { OPERATIONS } from "./operations";
import type { CalculationDefinition } from "./types";

/**
 * The allowlist of calculations, by id and version. Definitions reference them
 * as "<id>@<version>". A version never changes meaning once released: new
 * behaviour gets a new version, and pinned definitions keep the version they named.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL: CalculationDefinition<any, any>[] = [...FINANCE, ...ANALYTICS, ...OPERATIONS];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CALCULATIONS: Readonly<Record<string, Readonly<Record<string, CalculationDefinition<any, any>>>>> = Object.freeze(
  ALL.reduce<Record<string, Record<string, CalculationDefinition>>>((acc, def) => {
    if (acc[def.id]?.[def.version]) throw new Error(`calculation ${def.id}@${def.version} is registered twice`);
    (acc[def.id] ??= {})[def.version] = def;
    return acc;
  }, {}),
);

export const calculationRefs = () => ALL.map((d) => `${d.id}@${d.version}`).sort();
