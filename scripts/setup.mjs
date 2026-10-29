#!/usr/bin/env node
// Interactive, local-only setup: stores your Anthropic API key in .env.local (git-ignored, mode 600).
import readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { ENV_PATH, DEFAULT_MODEL, readEnvFile, writeEnvValue } from "./env-file.mjs";

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo so the key never appears on screen or in terminal scrollback.
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const existing = readEnvFile();
console.log("\n100 Workflows setup\n");
console.log("Your key is stored only in .env.local on this computer and is read by the local server.");
console.log("It is never sent to the browser. Usage is billed to your Anthropic account.\n");
if (existing.ANTHROPIC_API_KEY) console.log("A key is already configured. Paste a new one to replace it, or press Enter to keep it.\n");

const key = await askHidden("Anthropic API key (input hidden): ");
if (!key && existing.ANTHROPIC_API_KEY) {
  console.log("Keeping the existing key.");
} else if (!key) {
  console.error("No key entered. Get one at https://console.anthropic.com/settings/keys and run `npm run setup` again.");
  process.exit(1);
} else if (!key.startsWith("sk-ant-")) {
  console.error("That doesn't look like an Anthropic API key (they start with sk-ant-). Nothing was saved.");
  process.exit(1);
} else {
  writeEnvValue("ANTHROPIC_API_KEY", key);
  console.log(`Saved to ${ENV_PATH}`);
}

const env = readEnvFile();
const model = env.WORKFLOWS_MODEL || DEFAULT_MODEL;
process.stdout.write(`Checking the key against ${model} (free models endpoint, no tokens used)... `);
try {
  const info = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 }).models.retrieve(model);
  console.log(`ok (${info.display_name})`);
  console.log("\nDone. Start the app with `npm run dev` (restart it if it was already running).\n");
} catch (err) {
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  console.log("failed");
  if (err instanceof Anthropic.AuthenticationError) console.error("Anthropic rejected this key. Run `npm run setup` again with a valid key.");
  else if (err instanceof Anthropic.NotFoundError) console.error(`The key works but model "${model}" was not found. Check WORKFLOWS_MODEL.`);
  else if (err instanceof Anthropic.APIConnectionError) console.error("Couldn't reach Anthropic. The key was saved; check your connection and run `npm run check:config`.");
  else console.error(`Unexpected response${status ? ` (${status})` : ""}. The key was saved; run \`npm run check:config\` to retry.`);
  process.exit(1);
}
