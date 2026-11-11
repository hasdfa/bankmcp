import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.ts";

async function connect(attestOnly = false) {
  const server = createServer({ attestOnly });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wise-test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("Wise tools are opt-in and unavailable to attest-only grants", async () => {
  const previous = process.env.WISE_API_TOKEN;
  const previousAttestation = process.env.ATTESTATION_ENABLED;
  process.env.ATTESTATION_ENABLED = "1";
  try {
    for (const token of ["", "fixture-token"]) {
      process.env.WISE_API_TOKEN = token;
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
    if (previous === undefined) delete process.env.WISE_API_TOKEN;
    else process.env.WISE_API_TOKEN = previous;
  }
});

test("MCP preserves Wise statements and returns permission errors as errors", async () => {
  const previous = process.env.WISE_API_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.WISE_API_TOKEN = "fixture-token";
  let denied = false;
  globalThis.fetch = async () => denied
    ? new Response("private-body fixture-token", { status: 403 })
    : Response.json({ transactions: [{ details: { type: "BALANCE_INTEREST" }, amount: { value: 2, currency: "EUR" } }], extra: "preserved" });
  const session = await connect();
  try {
    const args = { profile_id: 1, balance_id: 2, currency: "EUR", from: "2026-01-01", to: "2026-01-31" };
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
    if (previous === undefined) delete process.env.WISE_API_TOKEN;
    else process.env.WISE_API_TOKEN = previous;
  }
});
