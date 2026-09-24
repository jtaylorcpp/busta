/**
 * Email security posture: what is actually published in DNS right now.
 *
 * Intent and reality drift. A record gets edited in the dashboard, a zone
 * transfer drops something, a policy is staged at `p=none` and nobody ever
 * goes back to tighten it. This queries DNS directly rather than trusting the
 * config file, so the answer is what the world can see.
 *
 * Read-only and safe to call from anywhere.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export type Grade = "ok" | "weak" | "missing" | "error";

export interface Finding {
  name: string;
  grade: Grade;
  value: string | null;
  detail: string;
}

interface DohAnswer {
  data: string;
}

async function txt(name: string): Promise<string[]> {
  const response = await fetch(
    `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`,
    { headers: { accept: "application/dns-json" } },
  );
  if (!response.ok) throw new Error(`DoH ${response.status} for ${name}`);
  const body = (await response.json()) as { Answer?: DohAnswer[] };
  // DoH returns TXT data quoted, and long records arrive as concatenated
  // quoted chunks that have to be rejoined before parsing.
  return (body.Answer ?? []).map((answer) =>
    answer.data.replace(/"\s*"/g, "").replace(/^"|"$/g, ""),
  );
}

function tag(record: string, key: string): string | null {
  return record.match(new RegExp(`\\b${key}\\s*=\\s*([^;\\s]+)`, "i"))?.[1] ?? null;
}

async function checkDmarc(domain: string): Promise<Finding> {
  const records = (await txt(`_dmarc.${domain}`)).filter((r) => /^v=DMARC1/i.test(r));
  if (records.length === 0) {
    return {
      name: "DMARC",
      grade: "missing",
      value: null,
      detail:
        "No DMARC record. Anyone can spoof this domain and receivers have no instruction to refuse it.",
    };
  }
  // More than one DMARC record is treated as none by receivers, so it is a
  // worse outcome than a weak policy and has to be called out separately.
  if (records.length > 1) {
    return {
      name: "DMARC",
      grade: "missing",
      value: records.join(" | "),
      detail: `${records.length} DMARC records published. Receivers treat multiple records as no policy at all — delete all but one.`,
    };
  }

  const record = records[0]!;
  const policy = (tag(record, "p") ?? "none").toLowerCase();
  const subdomain = (tag(record, "sp") ?? policy).toLowerCase();
  const rua = tag(record, "rua");
  const pct = Number(tag(record, "pct") ?? "100");

  const problems: string[] = [];
  if (policy === "none") problems.push("p=none only monitors — nothing is refused");
  if (policy === "quarantine") problems.push("p=quarantine sends spoofs to spam rather than refusing them");
  if (subdomain === "none") problems.push("sp=none leaves subdomains spoofable");
  if (!rua) problems.push("no rua= address, so no aggregate reports arrive");
  if (Number.isFinite(pct) && pct < 100) problems.push(`pct=${pct} applies the policy to only part of your mail`);

  return {
    name: "DMARC",
    grade: problems.length === 0 ? "ok" : policy === "reject" ? "weak" : "weak",
    value: record,
    detail:
      problems.length === 0
        ? "p=reject with reporting — spoofed mail is refused."
        : problems.join("; "),
  };
}

async function checkSpf(domain: string): Promise<Finding> {
  const records = (await txt(domain)).filter((r) => /^v=spf1/i.test(r));
  if (records.length === 0) {
    return { name: "SPF", grade: "missing", value: null, detail: "No SPF record published." };
  }
  if (records.length > 1) {
    return {
      name: "SPF",
      grade: "missing",
      value: records.join(" | "),
      detail: "Multiple SPF records is a permanent error — receivers fail the check outright.",
    };
  }

  const record = records[0]!;
  const all = record.match(/([-~?+])all\b/)?.[1] ?? null;
  return {
    name: "SPF",
    grade: all === "-" ? "ok" : all === "~" ? "weak" : "missing",
    value: record,
    detail:
      all === "-"
        ? "Ends in -all: unauthorised senders are a hard fail."
        : all === "~"
          ? "Ends in ~all (softfail). Fine while DMARC is staged; tighten to -all once reports are clean."
          : "No restrictive 'all' mechanism, so the record authorises nothing in practice.",
  };
}

async function checkMtaSts(domain: string): Promise<Finding[]> {
  const records = (await txt(`_mta-sts.${domain}`)).filter((r) => /^v=STSv1/i.test(r));
  const dnsFinding: Finding =
    records.length > 0
      ? {
          name: "MTA-STS (DNS)",
          grade: "ok",
          value: records[0]!,
          detail: "Policy is advertised. Senders will fetch it over HTTPS.",
        }
      : {
          name: "MTA-STS (DNS)",
          grade: "missing",
          value: null,
          detail: "Not advertised. Senders may deliver over plaintext without complaint.",
        };

  // Nothing advertises the policy, so there is nothing to fetch. Attempting
  // it anyway reports a connection error that reads like a fault when the
  // real state is simply "not configured".
  if (records.length === 0) {
    return [
      dnsFinding,
      {
        name: "MTA-STS (policy)",
        grade: "missing",
        value: null,
        detail: "Not checked — no policy is advertised in DNS, so no sender would fetch one.",
      },
    ];
  }

  // The DNS record is only half of it — an advertised policy that 404s is
  // worse than none, because senders cache the failure.
  let policyFinding: Finding;
  try {
    const response = await fetch(`https://mta-sts.${domain}/.well-known/mta-sts.txt`);
    if (!response.ok) {
      policyFinding = {
        name: "MTA-STS (policy)",
        grade: "error",
        value: null,
        detail: `Policy file returned HTTP ${response.status}. Advertising a policy that cannot be fetched is worse than not advertising one.`,
      };
    } else {
      const text = await response.text();
      const mode = text.match(/^\s*mode\s*:\s*(\w+)/im)?.[1]?.toLowerCase() ?? "none";
      policyFinding = {
        name: "MTA-STS (policy)",
        grade: mode === "enforce" ? "ok" : mode === "testing" ? "weak" : "missing",
        value: text.replace(/\s+/g, " ").slice(0, 160),
        detail:
          mode === "enforce"
            ? "mode: enforce — senders refuse to deliver without verified TLS."
            : mode === "testing"
              ? "mode: testing — violations are reported but mail still flows in the clear. Move to enforce once TLS-RPT is clean."
              : `mode: ${mode} disables the policy.`,
      };
    }
  } catch (error) {
    policyFinding = {
      name: "MTA-STS (policy)",
      grade: "error",
      value: null,
      detail: `Advertised in DNS but the policy file could not be fetched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return [dnsFinding, policyFinding];
}

async function checkTlsRpt(domain: string): Promise<Finding> {
  const records = (await txt(`_smtp._tls.${domain}`)).filter((r) => /^v=TLSRPTv1/i.test(r));
  return records.length > 0
    ? {
        name: "TLS-RPT",
        grade: "ok",
        value: records[0]!,
        detail: "TLS failures are reported, which is what makes MTA-STS testing mode useful.",
      }
    : {
        name: "TLS-RPT",
        grade: "missing",
        value: null,
        detail: "No TLS reporting. MTA-STS in testing mode reports into the void without this.",
      };
}

export interface PostureReport {
  domain: string;
  checkedAt: number;
  findings: Finding[];
  summary: { ok: number; weak: number; missing: number; error: number };
}

export async function checkPosture(domain: string): Promise<PostureReport> {
  const results = await Promise.all([
    checkSpf(domain).catch(errorFinding("SPF")),
    checkDmarc(domain).catch(errorFinding("DMARC")),
    checkMtaSts(domain).catch((error) => [errorFinding("MTA-STS")(error)]),
    checkTlsRpt(domain).catch(errorFinding("TLS-RPT")),
  ]);

  const findings = results.flat();
  const summary = { ok: 0, weak: 0, missing: 0, error: 0 };
  for (const finding of findings) summary[finding.grade] += 1;

  return { domain, checkedAt: Date.now(), findings, summary };
}

function errorFinding(name: string) {
  return (error: unknown): Finding => ({
    name,
    grade: "error",
    value: null,
    detail: `Lookup failed: ${error instanceof Error ? error.message : String(error)}`,
  });
}

/** The MTA-STS policy file this Worker serves. */
export function mtaStsPolicy(options: {
  mode: string;
  mx: string[];
  maxAgeSeconds: number;
}): string {
  return [
    "version: STSv1",
    `mode: ${options.mode}`,
    ...options.mx.map((host) => `mx: ${host}`),
    `max_age: ${options.maxAgeSeconds}`,
    "",
  ].join("\n");
}
