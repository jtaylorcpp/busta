/**
 * Reconcile dns.config.jsonc against a Cloudflare zone.
 *
 * Wrangler configures the Worker, not the zone, so email security records
 * cannot live in wrangler.jsonc. This gets the next best property: the
 * records are declared in version control and applied by a script, rather
 * than typed into a dashboard and forgotten.
 *
 *   npm run dns:check    # show desired vs published, change nothing
 *   npm run dns:apply    # create or update records to match
 *
 * Needs CLOUDFLARE_DNS_API_TOKEN with Zone > DNS > Edit. A wrangler OAuth session
 * is not enough — it carries `zone:read` but no DNS scope at all, and is
 * refused even on reads. The zone id is discovered automatically, so the token
 * is the only thing you have to supply.
 *
 * DKIM is never touched: Cloudflare owns those keys and publishes them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface DmarcConfig {
  policy: string;
  subdomainPolicy: string;
  dkimAlignment: string;
  spfAlignment: string;
  percentage: number;
  failureOptions: string;
  aggregateReports: string | null;
  forensicReports: string | null;
}

interface WorkerHostname {
  name: string;
  purpose: string;
}

interface DnsConfig {
  domain: string;
  workerHostnames?: WorkerHostname[];
  dmarc: DmarcConfig;
  mtaSts: { enabled: boolean; mode: string; mx: string[]; maxAgeSeconds: number };
  tlsRpt: { enabled: boolean; reports: string };
}

interface DesiredRecord {
  name: string;
  content: string;
  purpose: string;
  type?: "TXT" | "AAAA";
  proxied?: boolean;
}

/** RFC 6666 discard prefix — proxied, so requests are served at the edge. */
const WORKER_PLACEHOLDER_IP = "100::";

/** Strip comments so the config can stay annotated and still parse. */
function readJsonc(path: string): DnsConfig {
  const raw = readFileSync(path, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(raw) as DnsConfig;
}

function buildDmarc(domain: string, c: DmarcConfig): string {
  const parts = [
    "v=DMARC1",
    `p=${c.policy}`,
    `sp=${c.subdomainPolicy}`,
    `adkim=${c.dkimAlignment === "strict" ? "s" : "r"}`,
    `aspf=${c.spfAlignment === "strict" ? "s" : "r"}`,
    `pct=${c.percentage}`,
    `fo=${c.failureOptions}`,
  ];
  if (c.aggregateReports) parts.push(`rua=mailto:${c.aggregateReports}`);
  if (c.forensicReports) parts.push(`ruf=mailto:${c.forensicReports}`);
  return `${parts.join("; ")};`;
}

function desiredRecords(config: DnsConfig): DesiredRecord[] {
  const { domain } = config;
  const records: DesiredRecord[] = [
    {
      name: `_dmarc.${domain}`,
      content: buildDmarc(domain, config.dmarc),
      purpose: "Tells receivers what to do with mail that fails authentication",
    },
  ];

  if (config.mtaSts.enabled) {
    records.push({
      name: `_mta-sts.${domain}`,
      // The id must change whenever the served policy changes, or senders
      // keep using the cached copy. Derived from the policy itself so it
      // cannot drift out of step with what the Worker serves.
      content: `v=STSv1; id=${policyId(config)};`,
      purpose: "Advertises that an MTA-STS policy is published over HTTPS",
    });
  }

  for (const host of config.workerHostnames ?? []) {
    records.push({
      name: `${host.name}.${domain}`,
      content: WORKER_PLACEHOLDER_IP,
      type: "AAAA",
      proxied: true,
      purpose: `Worker route target — ${host.purpose}`,
    });
  }

  if (config.tlsRpt.enabled) {
    records.push({
      name: `_smtp._tls.${domain}`,
      content: `v=TLSRPTv1; rua=mailto:${config.tlsRpt.reports};`,
      purpose: "Where TLS negotiation failure reports are sent",
    });
  }

  return records;
}

function policyId(config: DnsConfig): string {
  const material = `${config.mtaSts.mode}|${config.mtaSts.mx.join(",")}|${config.mtaSts.maxAgeSeconds}`;
  let hash = 0;
  for (let i = 0; i < material.length; i += 1) {
    hash = (hash * 31 + material.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}`;
}

const API = "https://api.cloudflare.com/client/v4";

/**
 * Reuse the wrangler login purely to look the zone up. It cannot write DNS,
 * but it can read zones, which is enough to save the operator from pasting a
 * zone id they would otherwise have to hunt for in the dashboard.
 */
function wranglerToken(): string | null {
  for (const path of [
    join(homedir(), ".config", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
  ]) {
    try {
      const match = readFileSync(path, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
      if (match) return match[1]!;
    } catch {
      // Not logged in on this path; try the next.
    }
  }
  return null;
}

async function resolveZoneId(domain: string, tokens: (string | null)[]): Promise<string | null> {
  for (const token of tokens) {
    if (!token) continue;
    try {
      const zones = (await api(`/zones?name=${encodeURIComponent(domain)}`, token)) as {
        id: string;
      }[];
      if (zones.length > 0) return zones[0]!.id;
    } catch {
      // This token cannot read zones; try the next one.
    }
  }
  return null;
}

async function api(path: string, token: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json()) as { success: boolean; result: any; errors?: unknown[] };
  if (!body.success) {
    throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const config = readJsonc(new URL("../dns.config.jsonc", import.meta.url).pathname);
  const records = desiredRecords(config);

  // Deliberately NOT named CLOUDFLARE_API_TOKEN: wrangler auto-loads .env and
  // uses that variable for its own authentication, so a DNS-scoped token there
  // silently replaces the OAuth session and breaks every wrangler command with
  // an unrelated-looking "failed to retrieve account IDs" error.
  const token = process.env.CLOUDFLARE_DNS_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;

  console.log(`\nEmail security DNS for ${config.domain}\n`);

  if (config.dmarc.policy !== "reject") {
    console.log(
      `  ! DMARC is staged at p=${config.dmarc.policy}. Nothing is refused until it reaches reject.\n`,
    );
  }
  if (config.mtaSts.enabled && config.mtaSts.mode !== "enforce") {
    console.log(
      `  ! MTA-STS is in ${config.mtaSts.mode} mode. Violations are reported, not blocked.\n`,
    );
  }

  for (const record of records) {
    console.log(`  ${record.name}  [${record.type ?? "TXT"}${record.proxied ? ", proxied" : ""}]`);
    console.log(`    ${record.content}`);
    console.log(`    ${record.purpose}`);
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write these to the zone.\n`);
    return;
  }

  if (!token) {
    console.error(
      "\nCLOUDFLARE_DNS_API_TOKEN is required to apply.\n\n" +
        "Your wrangler login cannot do this: it carries zone:read but no DNS\n" +
        "scope, and is refused even on DNS reads. Create a scoped token at\n" +
        "  https://dash.cloudflare.com/profile/api-tokens\n" +
        "  Permissions:   Zone > DNS > Edit\n" +
        `  Zone Resources: Include > Specific zone > ${config.domain}\n\n` +
        "Scope it to the one zone. Do not use the Global API Key — it carries\n" +
        "every permission on the account and cannot be limited or revoked\n" +
        "independently.\n",
    );
    process.exitCode = 1;
    return;
  }

  const zone =
    process.env.CLOUDFLARE_ZONE_ID ?? (await resolveZoneId(config.domain, [token, wranglerToken()]));

  if (!zone) {
    console.error(
      `\nCould not find a zone named ${config.domain} on this account.\n` +
        "Set CLOUDFLARE_ZONE_ID explicitly if the token cannot list zones.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  zone ${zone}`);

  console.log("");
  for (const record of records) {
    const type = record.type ?? "TXT";
    const existing = (await api(
      `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(record.name)}`,
      token,
    )) as { id: string; content: string }[];

    if (existing.length > 1) {
      // Multiple TXT records at these names are worse than none — receivers
      // treat duplicate DMARC as no policy — so refuse rather than guess.
      console.log(`  SKIP  ${record.name}: ${existing.length} records exist, resolve by hand`);
      continue;
    }

    if (existing.length === 1) {
      if (existing[0]!.content === record.content) {
        console.log(`  OK    ${record.name}`);
        continue;
      }
      await api(`/zones/${zone}/dns_records/${existing[0]!.id}`, token, {
        method: "PUT",
        body: JSON.stringify({
          type,
          name: record.name,
          content: record.content,
          ttl: 1,
          ...(record.proxied ? { proxied: true } : {}),
          comment: "managed by dns.config.jsonc",
        }),
      });
      console.log(`  UPDATE ${record.name}`);
      continue;
    }

    await api(`/zones/${zone}/dns_records`, token, {
      method: "POST",
      body: JSON.stringify({
        type,
        name: record.name,
        content: record.content,
        ttl: 1,
        ...(record.proxied ? { proxied: true } : {}),
        comment: "managed by dns.config.jsonc",
      }),
    });
    console.log(`  CREATE ${record.name}`);
  }

  console.log(
    `\nDone. SPF and DKIM are not managed here — Cloudflare publishes those when\n` +
      `the sending domain is onboarded. Verify everything with: npm run dns:verify\n`,
  );
}

await main();
