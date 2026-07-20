import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const supplierIds = ["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"];
const supplierIdSet = new Set(supplierIds);
const finalStatuses = new Set(["completed", "timeout", "auth_error", "error"]);
const sampleArticles = [
  "90915YZZJ1",
  "OC90",
  "W712/95",
  "C 30 005",
  "0986452041",
  "VAP-021-2375",
  "5050LR",
  "7701208174",
  "06A115561B",
  "2630035504",
  "15208-65F0E",
  "MANN-W914/2",
  "LX2046",
  "1 987 429 404",
  "GDB1330",
  "PN3203",
  "VKBA 3646",
  "CT1028K3",
  "K20TT",
  "BKR6E-11",
];

function usage() {
  return `Usage:
  node scripts/audit-articles.mjs [options] ARTICLE...
  node scripts/audit-articles.mjs --file articles.txt
  Get-Content articles.txt | node scripts/audit-articles.mjs

Options:
  --url URL             Server URL (default: http://127.0.0.1:3000)
  --file PATH           UTF-8 file with one article per line
  --supplier IDS        Comma-separated supplier IDs; can be repeated
  --concurrency N       Parallel article searches (default: 2, max: 10)
  --timeout MS          Timeout for one article (default: 90000)
  --output-dir PATH     Report parent directory (default: article-audit-reports)
  --sample              Test the built-in set of ${sampleArticles.length} articles
  --help                Show this help

Blank lines and lines beginning with # are ignored. Reports are written below the
current working directory unless --output-dir is an absolute path.`;
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArguments(args) {
  const options = {
    url: "http://127.0.0.1:3000",
    files: [],
    suppliers: [],
    concurrency: 2,
    timeoutMs: 90_000,
    outputDir: "article-audit-reports",
    articles: [],
    sample: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--sample") {
      options.sample = true;
    } else if (["--url", "--file", "--supplier", "--concurrency", "--timeout", "--output-dir"].includes(argument)) {
      const value = takeValue(args, index, argument);
      index += 1;
      if (argument === "--url") options.url = value;
      if (argument === "--file") options.files.push(value);
      if (argument === "--supplier") options.suppliers.push(...value.split(","));
      if (argument === "--concurrency") options.concurrency = Number(value);
      if (argument === "--timeout") options.timeoutMs = Number(value);
      if (argument === "--output-dir") options.outputDir = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.articles.push(argument);
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    throw new Error("--url must be a valid http:// or https:// URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("--url must use http:// or https://");
  }
  options.url = parsedUrl.toString().replace(/\/$/, "");

  options.suppliers = [...new Set(options.suppliers.map((value) => value.trim()).filter(Boolean))];
  const unknownSuppliers = options.suppliers.filter((value) => !supplierIdSet.has(value));
  if (unknownSuppliers.length) {
    throw new Error(`Unknown supplier IDs: ${unknownSuppliers.join(", ")}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
    throw new Error("--concurrency must be an integer from 1 to 10");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 600_000) {
    throw new Error("--timeout must be an integer from 1000 to 600000 milliseconds");
  }
  return options;
}

function parseArticleText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return parseArticleText(text);
}

async function collectArticles(options) {
  const articles = [...options.articles];
  for (const file of options.files) {
    articles.push(...parseArticleText(await readFile(resolve(file), "utf8")));
  }
  if (options.sample) articles.push(...sampleArticles);
  if (!articles.length && !process.stdin.isTTY) articles.push(...await readStdin());

  const unique = [];
  const seen = new Set();
  for (const article of articles.map((value) => value.trim())) {
    if (!article || seen.has(article)) continue;
    if (article.length > 128) throw new Error(`Article exceeds 128 characters: ${article.slice(0, 40)}...`);
    seen.add(article);
    unique.push(article);
  }
  if (!unique.length) throw new Error("No articles supplied. Use arguments, --file, stdin, or --sample.");
  return unique;
}

export async function readSseEvents(response, onEvent) {
  if (!response.body) throw new Error("Search response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) onEvent(JSON.parse(data));
  }
}

function normalizedArticle(value) {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
}

function addIssue(issues, severity, code, message, supplier) {
  issues.push({ severity, code, message, ...(supplier ? { supplier } : {}) });
}

function validDate(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function validateResult(result, requestedArticle, issues) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    addIssue(issues, "error", "invalid_result", "Result payload is not an object");
    return;
  }
  const supplier = typeof result.supplier === "string" ? result.supplier : undefined;
  if (!supplier || !supplierIdSet.has(supplier)) addIssue(issues, "error", "invalid_supplier", "Result has an unknown supplier");
  for (const field of ["brand", "article", "title"]) {
    if (typeof result[field] !== "string" || !result[field].trim()) addIssue(issues, "error", `invalid_${field}`, `Result ${field} must be a non-empty string`, supplier);
  }
  if (typeof result.article === "string" && normalizedArticle(result.article) !== normalizedArticle(requestedArticle)) {
    addIssue(issues, "error", "article_mismatch", `Returned article '${result.article}' does not match the request`, supplier);
  }
  if (typeof result.price !== "number" || !Number.isFinite(result.price) || result.price <= 0) addIssue(issues, "error", "invalid_price", "Price must be a finite positive number", supplier);
  if (result.warehouse !== null && typeof result.warehouse !== "string") addIssue(issues, "error", "invalid_warehouse", "Warehouse must be a string or null", supplier);
  if (result.deliveryDate !== null && !validDate(result.deliveryDate)) addIssue(issues, "error", "invalid_delivery_date", "Delivery date is invalid", supplier);
  if (result.deliveryDateTo !== undefined && result.deliveryDateTo !== null && !validDate(result.deliveryDateTo)) addIssue(issues, "error", "invalid_delivery_date_to", "Delivery end date is invalid", supplier);
  if (typeof result.deliveryDateApproximate !== "boolean") addIssue(issues, "error", "invalid_approximate_flag", "deliveryDateApproximate must be boolean", supplier);
  try {
    const link = new URL(result.link);
    if (!["http:", "https:"].includes(link.protocol)) throw new Error();
  } catch {
    addIssue(issues, "error", "invalid_link", "Link must be a valid HTTP(S) URL", supplier);
  }
}

export function analyzeEvents(article, events, requestedSuppliers = []) {
  const issues = [];
  const results = [];
  const statuses = {};
  let started = null;
  let completed = false;
  let fatal = false;

  for (const event of events) {
    if (!event || typeof event !== "object") {
      addIssue(issues, "error", "invalid_event", "SSE event is not an object");
      continue;
    }
    if (event.type === "search_started") {
      if (started) addIssue(issues, "error", "duplicate_start", "Search emitted search_started more than once");
      started = event;
      if (event.article !== article) addIssue(issues, "error", "start_article_mismatch", "search_started contains another article");
    } else if (event.type === "supplier_status") {
      if (!supplierIdSet.has(event.supplier)) {
        addIssue(issues, "error", "invalid_status_supplier", "Status contains an unknown supplier");
        continue;
      }
      if (event.status === "searching") {
        if (statuses[event.supplier]) addIssue(issues, "warning", "duplicate_searching", "Supplier started more than once", event.supplier);
        statuses[event.supplier] = { status: "searching" };
      } else if (finalStatuses.has(event.status)) {
        if (!statuses[event.supplier]) addIssue(issues, "error", "missing_searching", "Supplier finished before searching status", event.supplier);
        statuses[event.supplier] = { status: event.status, ...(typeof event.details === "string" ? { details: event.details } : {}) };
        if (event.status !== "completed") addIssue(issues, "error", `supplier_${event.status}`, event.details || `Supplier finished with ${event.status}`, event.supplier);
      } else {
        addIssue(issues, "error", "invalid_status", `Unknown supplier status: ${String(event.status)}`, event.supplier);
      }
    } else if (event.type === "result") {
      validateResult(event.result, article, issues);
      results.push(event.result);
    } else if (event.type === "search_completed") {
      completed = true;
      if (event.article !== article) addIssue(issues, "error", "completion_article_mismatch", "search_completed contains another article");
    } else if (event.type === "fatal_error") {
      fatal = true;
      addIssue(issues, "error", "fatal_error", typeof event.message === "string" ? event.message : "Search emitted fatal_error");
    } else {
      addIssue(issues, "error", "unknown_event", `Unknown SSE event type: ${String(event.type)}`);
    }
  }

  if (!started) addIssue(issues, "error", "missing_start", "search_started was not received");
  if (!completed && !fatal) addIssue(issues, "error", "missing_completion", "search_completed was not received");
  const expectedSuppliers = requestedSuppliers.length ? requestedSuppliers : (Array.isArray(started?.suppliers) ? started.suppliers : []);
  for (const supplier of expectedSuppliers) {
    if (!statuses[supplier]) addIssue(issues, "error", "missing_supplier_status", "Supplier emitted no status", supplier);
    else if (!finalStatuses.has(statuses[supplier].status)) addIssue(issues, "error", "unfinished_supplier", "Supplier has no final status", supplier);
  }
  if (!results.length && !issues.some((issue) => issue.severity === "error")) addIssue(issues, "warning", "no_results", "Search completed successfully but returned no offers");

  const duplicates = new Map();
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const key = JSON.stringify([result.supplier, result.brand, result.article, result.price, result.warehouse, result.deliveryDate, result.deliveryDateTo]);
    duplicates.set(key, (duplicates.get(key) || 0) + 1);
  }
  const duplicateCount = [...duplicates.values()].reduce((count, value) => count + Math.max(0, value - 1), 0);
  if (duplicateCount) addIssue(issues, "warning", "duplicate_results", `${duplicateCount} duplicate offer(s) detected`);

  return { results, statuses, issues };
}

export async function auditArticle({ baseUrl, article, suppliers, timeoutMs }) {
  const startedAt = new Date();
  const url = new URL("/api/search", `${baseUrl}/`);
  url.searchParams.set("article", article);
  url.searchParams.set("stream", "once");
  for (const supplier of suppliers) url.searchParams.append("supplier", supplier);
  const events = [];
  let transportError = null;

  try {
    const response = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (!(response.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream")) throw new Error(`Unexpected Content-Type: ${response.headers.get("content-type") || "missing"}`);
    await readSseEvents(response, (event) => events.push(event));
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }

  const analysis = analyzeEvents(article, events, suppliers);
  if (transportError) addIssue(analysis.issues, "error", "transport_error", transportError);
  const finishedAt = new Date();
  return {
    article,
    startedAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    outcome: analysis.issues.some((issue) => issue.severity === "error") ? "failed" : analysis.issues.length ? "warning" : "passed",
    resultCount: analysis.results.length,
    statuses: analysis.statuses,
    issues: analysis.issues,
    results: analysis.results,
  };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function markdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function createMarkdown(report) {
  const lines = [
    "# Article audit report",
    "",
    `- Started: ${report.startedAt}`,
    `- Server: ${report.serverUrl}`,
    `- Articles: ${report.summary.total}`,
    `- Passed: ${report.summary.passed}`,
    `- Warnings: ${report.summary.warning}`,
    `- Failed: ${report.summary.failed}`,
    `- Offers: ${report.summary.results}`,
    "",
    "## Articles",
    "",
    "| Article | Outcome | Duration | Offers | Supplier statuses | Issues |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const item of report.articles) {
    const statuses = Object.entries(item.statuses).map(([supplier, status]) => `${supplier}: ${status.status}`).join(", ") || "none";
    const issues = item.issues.map((issue) => `${issue.severity}: ${issue.supplier ? `${issue.supplier}: ` : ""}${issue.message}`).join("; ") || "none";
    lines.push(`| ${markdownCell(item.article)} | ${item.outcome} | ${item.durationMs} ms | ${item.resultCount} | ${markdownCell(statuses)} | ${markdownCell(issues)} |`);
  }
  lines.push("", "## Problem details", "");
  const problematic = report.articles.filter((item) => item.issues.length);
  if (!problematic.length) lines.push("No issues detected.");
  for (const item of problematic) {
    lines.push(`### ${item.article}`, "");
    for (const issue of item.issues) lines.push(`- **${issue.severity} / ${issue.code}**${issue.supplier ? ` (${issue.supplier})` : ""}: ${issue.message}`);
    lines.push("");
  }
  lines.push("## Interpretation", "", "- `failed`: a transport, protocol, supplier, or normalized-data error was detected.", "- `warning`: the search completed, but returned no offers or duplicate offers.", "- `passed`: all selected suppliers completed and returned structurally valid data.", "- A passed result verifies observable API consistency, not upstream catalog correctness.", "");
  return lines.join("\n");
}

function timestampDirectory(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const articles = await collectArticles(options);
  const healthResponse = await fetch(new URL("/api/health", `${options.url}/`), { signal: AbortSignal.timeout(10_000) });
  if (!healthResponse.ok) throw new Error(`Server health check failed with HTTP ${healthResponse.status}`);

  const startedAt = new Date();
  process.stdout.write(`Auditing ${articles.length} article(s) against ${options.url}\n`);
  const audited = await mapConcurrent(articles, options.concurrency, async (article, index) => {
    const result = await auditArticle({ baseUrl: options.url, article, suppliers: options.suppliers, timeoutMs: options.timeoutMs });
    process.stdout.write(`[${index + 1}/${articles.length}] ${article}: ${result.outcome}, ${result.resultCount} offer(s), ${result.durationMs} ms\n`);
    return result;
  });
  const summary = {
    total: audited.length,
    passed: audited.filter((item) => item.outcome === "passed").length,
    warning: audited.filter((item) => item.outcome === "warning").length,
    failed: audited.filter((item) => item.outcome === "failed").length,
    results: audited.reduce((total, item) => total + item.resultCount, 0),
  };
  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    serverUrl: options.url,
    selectedSuppliers: options.suppliers.length ? options.suppliers : supplierIds,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    summary,
    articles: audited,
  };
  const reportDir = resolve(options.outputDir, timestampDirectory(startedAt));
  await mkdir(reportDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(resolve(reportDir, "report.md"), createMarkdown(report), "utf8"),
  ]);
  process.stdout.write(`Report: ${reportDir}\n`);
  process.exitCode = summary.failed ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Article audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
