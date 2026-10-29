#!/usr/bin/env node
// Verifies .env.local without spending credits: it only calls the provider's free models endpoint.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ENV_PATH, readEnvFile } from "./env-file.mjs";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "WORKFLOWS_MODEL", "WORKFLOWS_PROVIDER"];
const env = { ...readEnvFile(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => KEYS.includes(k))) };

// Same rule as src/lib/providers.ts: explicit choice, else whichever key is set (Anthropic first).
const explicit = env.WORKFLOWS_PROVIDER?.trim().toLowerCase();
const provider = explicit === "openai" || explicit === "anthropic" ? explicit : env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : "anthropic";
const SDK = provider === "openai" ? OpenAI : Anthropic;
const keyVar = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
const model = env.WORKFLOWS_MODEL || (provider === "openai" ? "gpt-6.1-sol" : "claude-opus-5-5");

if (!env[keyVar]) {
  console.error(`No ${keyVar} found in ${ENV_PATH} or the environment.${provider === "anthropic" ? " Run `npm run setup`." : ""}`);
  process.exit(1);
}
try {
  const info = await new SDK({ apiKey: env[keyVar], maxRetries: 1 }).models.retrieve(model);
  console.log(`OK: ${provider} key is valid and can use ${info.id}${info.display_name ? ` (${info.display_name})` : ""}.`);
} catch (err) {
  if (err instanceof SDK.AuthenticationError) console.error(`${provider} rejected the key in ${keyVar}.`);
  else if (err instanceof SDK.NotFoundError) console.error(`Model "${model}" not found for this ${provider} key. Check WORKFLOWS_MODEL.`);
  else if (err instanceof SDK.APIConnectionError) console.error(`Couldn't reach ${provider}. Check your internet connection.`);
  else console.error(`Check failed${err instanceof SDK.APIError ? ` (HTTP ${err.status})` : ""}.`);
  process.exit(1);
}
