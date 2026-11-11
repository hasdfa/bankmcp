import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const money = z.object({ value: z.number(), currency: z.string() }).passthrough();
const profile = z.object({ id, type: z.string() }).passthrough();
const balance = z.object({
  id,
  currency: z.string(),
  type: z.string(),
  name: z.string().nullable().optional(),
  investmentState: z.string().optional(),
  amount: money,
  reservedAmount: money.optional(),
  cashAmount: money.optional(),
  totalWorth: money.optional(),
}).passthrough();
const statement = z.object({ transactions: z.array(z.record(z.string(), z.unknown())) }).passthrough();

export class WiseError extends Error {}

function date(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new WiseError("Use a valid calendar date in YYYY-MM-DD format.");
  }
  return parsed;
}

/** Fixed-origin, GET-only access; credentials never follow redirects or appear in errors. */
export class WiseClient {
  private token: string;
  private request: typeof fetch;

  constructor(token: string, request: typeof fetch = fetch) {
    this.token = token;
    this.request = request;
  }

  private async get<T>(path: string, schema: z.ZodType<T>, query?: Record<string, string>): Promise<T> {
    const url = new URL(`https://api.wise.com/2026Q4${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new WiseError("Wise request failed or timed out. No data was retrieved; this is not an empty balance or transaction history.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 && response.headers.has("x-2fa-approval")) {
        throw new WiseError("Wise API 403: Strong Customer Authentication is required. This integration cannot complete Wise SCA. Personal-token statement access is restricted in some regions; use a Wise-exported statement instead. No statement was retrieved.");
      }
      const hint = response.status === 401 ? "Check the Wise API token."
        : response.status === 403 ? "The token may not permit this profile or endpoint, or Wise may require Strong Customer Authentication. Personal-token statement access is region-restricted."
        : response.status === 429 ? "Wise rate limit reached; retry later."
        : "The requested data could not be read.";
      throw new WiseError(`Wise API ${response.status}: ${hint} Do not interpret this as zero holdings or no transactions.`);
    }
    try {
      const result = schema.safeParse(await response.json());
      if (result.success) return result.data;
    } catch {
      // Response bodies may contain private data; report only the failure category.
    }
    throw new WiseError("Wise returned an unexpected response; no reliable data could be read.");
  }

  async listProfiles() {
    return this.get("/profiles", z.array(profile));
  }

  async listBalances(profileId: number) {
    return this.get(`/profiles/${id.parse(profileId)}/balances`, z.array(balance), { types: "STANDARD,SAVINGS" });
  }

  async getBalance(profileId: number, balanceId: number) {
    return this.get(`/profiles/${id.parse(profileId)}/balances/${id.parse(balanceId)}`, balance);
  }

  async getStatement(profileId: number, balanceId: number, currency: string, from: string, to: string) {
    const start = date(from);
    const end = date(to);
    end.setUTCHours(23, 59, 59, 999);
    if (end < start || end.getTime() - start.getTime() > 469 * 86_400_000) {
      throw new WiseError("Statement dates must be ordered and span at most 469 calendar days. Split longer histories into non-overlapping ranges; no data was fetched.");
    }
    return this.get(`/profiles/${id.parse(profileId)}/balance-statements/${id.parse(balanceId)}/statement.json`, statement, {
      currency: z.string().regex(/^[A-Z]{3}$/).parse(currency),
      intervalStart: start.toISOString(),
      intervalEnd: end.toISOString(),
      type: "COMPACT",
    });
  }
}
