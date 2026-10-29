import { describe, expect, it } from "vitest";
import { checkLocalRequest } from "@/lib/request-guard";
import { getModelConfig } from "@/lib/server/config";
import { redact } from "@/lib/server/log";

const post = { method: "POST", host: "localhost:3000", origin: "http://localhost:3000", contentType: "application/json" };

describe("checkLocalRequest", () => {
  it("allows same-origin JSON POSTs on localhost", () => {
    expect(checkLocalRequest(post)).toEqual({ ok: true });
    expect(checkLocalRequest({ ...post, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" })).toEqual({ ok: true });
    expect(checkLocalRequest({ ...post, host: "[::1]:3000", origin: "http://[::1]:3000" })).toEqual({ ok: true });
  });

  it("blocks DNS-rebinding style hosts", () => {
    expect(checkLocalRequest({ ...post, host: "evil.example:3000", origin: "http://evil.example:3000" })).toMatchObject({ ok: false, status: 403 });
    expect(checkLocalRequest({ ...post, host: null })).toMatchObject({ ok: false });
  });

  it("blocks cross-origin and origin-less POSTs", () => {
    expect(checkLocalRequest({ ...post, origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 });
    expect(checkLocalRequest({ ...post, origin: null })).toMatchObject({ ok: false, status: 403 });
    expect(checkLocalRequest({ ...post, origin: "not a url" })).toMatchObject({ ok: false });
  });

  it("requires JSON so simple cross-site form posts can't reach the API", () => {
    expect(checkLocalRequest({ ...post, contentType: "text/plain" })).toMatchObject({ ok: false, status: 415 });
  });

  it("lets GETs through from localhost only", () => {
    expect(checkLocalRequest({ ...post, method: "GET", origin: null, contentType: null })).toEqual({ ok: true });
    expect(checkLocalRequest({ ...post, method: "GET", host: "evil.example" })).toMatchObject({ ok: false });
  });

  it("supports explicitly allowed extra hosts", () => {
    expect(
      checkLocalRequest({ ...post, host: "box.lan:3000", origin: "http://box.lan:3000", extraAllowedHosts: ["box.lan"] }),
    ).toEqual({ ok: true });
  });
});

describe("redact", () => {
  it("removes API keys from strings and nested objects", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const out = JSON.stringify(redact({ message: `bad key ${key}`, headers: { "x-api-key": key, Authorization: "Bearer abc" }, list: [key] }));
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("Bearer abc");
  });

  it("redacts OpenAI keys too", () => {
    const out = JSON.stringify(redact({ message: "bad key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx" }));
    expect(out).not.toContain("AbCdEfGh");
  });

  it("keeps errors readable", () => {
    expect(redact(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });
});

describe("getModelConfig", () => {
  it("reports a missing key without throwing", () => {
    expect(getModelConfig({})).toMatchObject({ configured: false, model: "claude-opus-5-5" });
  });
  it("flags keys with the wrong shape", () => {
    expect(getModelConfig({ ANTHROPIC_API_KEY: "sk-openai-123" }).configured).toBe(false);
  });
  it("never includes the key in its result", () => {
    const result = getModelConfig({ ANTHROPIC_API_KEY: "sk-ant-secret-value", WORKFLOWS_MODEL: "claude-sonnet-5-5" });
    expect(result).toEqual({ configured: true, provider: "anthropic", providerLabel: "Anthropic", model: "claude-sonnet-5-5", keyVar: "ANTHROPIC_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
