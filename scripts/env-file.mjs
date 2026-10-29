import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

export const ENV_PATH = path.join(process.cwd(), ".env.local");

/** Minimal KEY=value parser; enough for the handful of settings 100 Workflows uses. */
export function readEnvFile(file = ENV_PATH) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Updates one key in .env.local, keeping other lines, and restricts the file to the current user. */
export function writeEnvValue(key, value, file = ENV_PATH) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.match(new RegExp(`^\\s*${key}\\s*=`)));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  writeFileSync(file, lines.join("\n").trimEnd() + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export const DEFAULT_MODEL = "claude-opus-5-5";
