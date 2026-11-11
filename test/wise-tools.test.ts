import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/mcp.ts";

async function connect(attestOnly = false) {
  const server = createServer({ attestOnly });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wise-test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("Wise tools are opt-in and unavailable to attest-only grants", async () => {
  const previous = process.env.CUSTOM_ACCOUNTS_FILE;
  const previousAttestation = process.env.ATTESTATION_ENABLED;
  process.env.ATTESTATION_ENABLED = "1";
  try {
    for (const token of ["", "fixture-token"]) {
      process.env.CUSTOM_ACCOUNTS_FILE = token ? configuration() : "";
      for (const attestOnly of [false, true]) {
        const session = await connect(attestOnly);
        try {
          const wise = (await session.client.listTools()).tools.filter((t) => t.name.includes("wise"));
          assert.equal(wise.length, token && !attestOnly ? 4 : 0);
          for (const tool of wise) assert.equal(tool.annotations?.readOnlyHint, true);
        } finally { await session.close(); }
      }
    }
  } finally {
    if (previousAttestation === undefined) delete process.env.ATTESTATION_ENABLED;
    else process.env.ATTESTATION_ENABLED = previousAttestation;
    if (previous === undefined) delete process.env.CUSTOM_ACCOUNTS_FILE;
    else process.env.CUSTOM_ACCOUNTS_FILE = previous;
  }
});

test("MCP preserves Wise statements and returns permission errors as errors", async () => {
  const previous = process.env.CUSTOM_ACCOUNTS_FILE;
  const originalFetch = globalThis.fetch;
  process.env.CUSTOM_ACCOUNTS_FILE = configuration();
  let denied = false;
  globalThis.fetch = async () => denied
    ? new Response("private-body fixture-token", { status: 403 })
    : Response.json({ transactions: [{ details: { type: "BALANCE_INTEREST" }, amount: { value: 2, currency: "EUR" } }], extra: "preserved" });
  const session = await connect();
  try {
    const args = { account: "Business", profile_id: 1, balance_id: 2, currency: "EUR", from: "2026-01-01", to: "2026-01-31" };
    const result = await session.client.callTool({ name: "get_wise_statement", arguments: args });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result.content), /BALANCE_INTEREST/);
    assert.match(JSON.stringify(result.content), /preserved/);
    denied = true;
    const error = await session.client.callTool({ name: "get_wise_statement", arguments: args });
    assert.equal(error.isError, true);
    assert.match(JSON.stringify(error.content), /403/);
    assert.doesNotMatch(JSON.stringify(error.content), /fixture-token|private-body/);
  } finally {
    await session.close();
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.CUSTOM_ACCOUNTS_FILE;
    else process.env.CUSTOM_ACCOUNTS_FILE = previous;
  }
});

function configuration() {
  const path = join(mkdtempSync(join(tmpdir(), "bank-wise-")), "accounts.yaml");
  writeFileSync(path, JSON.stringify({ accounts: [
    { label: "Business", description: "Business banking", provider: "wise", config: { api_key: "fixture-token" } },
    { label: "Personal", description: "Personal banking", provider: "wise", config: { api_key: "personal-token" } },
  ] }));
  return path;
}

test("account selection routes identical profile IDs to distinct credentials and discovery excludes secrets", async () => {
  const previous = process.env.CUSTOM_ACCOUNTS_FILE;
  const originalFetch = globalThis.fetch;
  process.env.CUSTOM_ACCOUNTS_FILE = configuration();
  const tokens: Array<string | null> = [];
  globalThis.fetch = async (_url, init) => {
    tokens.push(new Headers(init?.headers).get("Authorization"));
    return Response.json([]);
  };
  const session = await connect();
  try {
    const discovery = await session.client.callTool({ name: "list_custom_accounts" });
    const text = JSON.stringify(discovery);
    assert.match(text, /Business banking/);
    assert.match(text, /Personal banking/);
    assert.doesNotMatch(text, /fixture-token|personal-token|api_key|config/);
    for (const account of ["Business", "Personal"]) {
      const response = await session.client.callTool({ name: "list_wise_balances", arguments: { account, profile_id: 1 } });
      assert.notEqual(response.isError, true);
      assert.match(JSON.stringify(response), new RegExp(account));
    }
    assert.deepEqual(tokens, ["Bearer fixture-token", "Bearer personal-token"]);
    const unknown = await session.client.callTool({ name: "list_wise_balances", arguments: { account: "Unknown", profile_id: 1 } });
    assert.equal(unknown.isError, true);
    assert.equal(tokens.length, 2);
  } finally {
    await session.close();
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.CUSTOM_ACCOUNTS_FILE;
    else process.env.CUSTOM_ACCOUNTS_FILE = previous;
  }
});
