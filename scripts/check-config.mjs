#!/usr/bin/env node
// Verifies .env.local without spending credits: it only calls the free models endpoint.
import Anthropic from "@anthropic-ai/sdk";
import { ENV_PATH, DEFAULT_MODEL, readEnvFile } from "./env-file.mjs";

const env = { ...readEnvFile(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "ANTHROPIC_API_KEY" || k === "WORKFLOWS_MODEL")) };
const model = env.WORKFLOWS_MODEL || DEFAULT_MODEL;

if (!env.ANTHROPIC_API_KEY) {
  console.error(`No ANTHROPIC_API_KEY found in ${ENV_PATH} or the environment. Run \`npm run setup\`.`);
  process.exit(1);
}
try {
  const info = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 }).models.retrieve(model);
  console.log(`OK: key is valid and can use ${info.id} (${info.display_name}).`);
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("Anthropic rejected the key. Run `npm run setup` to replace it.");
  else if (err instanceof Anthropic.NotFoundError) console.error(`Model "${model}" not found for this key. Check WORKFLOWS_MODEL.`);
  else if (err instanceof Anthropic.APIConnectionError) console.error("Couldn't reach Anthropic. Check your internet connection.");
  else console.error(`Check failed${err instanceof Anthropic.APIError ? ` (HTTP ${err.status})` : ""}.`);
  process.exit(1);
}
