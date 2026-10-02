/**
 * Model-facing WeChat Official Account (公众号) pipeline tools.
 *
 * This plugin is a thin, typed bridge over the already-proven
 * `gzh_auto.py` script from the `gzh-auto-publisher` skill. It deliberately
 * does NOT reimplement the WeChat API: that script owns account config
 * loading, the access-token handshake, draft creation, and the pre-publish
 * quality gate. Duplicating any of it here would create two sources of truth
 * for a credentialed, rate-limited API.
 *
 * What this plugin adds on top of "just run the script":
 *   - a typed, model-facing schema (the model never hand-writes flags)
 *   - structured output the Agent can reason about (gate reasons, media_id)
 *   - `gzh_validate` as a dry-run that never touches the network
 *   - `gzh_check` / `gzh_verify` split so config problems and credential
 *     problems are distinguishable without publishing anything
 *   - one stable place to point every account's working directory at
 *
 * Tool surface:
 *   gzh_accounts    — list configured accounts                    (offline)
 *   gzh_validate    — run the publish gate on a draft             (offline)
 *   gzh_check       — account config / env-file health            (offline)
 *   gzh_push_draft  — validate then push to the WeChat draft box  (live)
 *   gzh_verify      — fetch an access_token                       (live)
 *
 * @module dsh-tool-gzh-publisher
 */
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-gzh-publisher";

/** Services required by the publisher tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call budget (ms); WeChat uploads can be slow. */
const DEFAULT_TIMEOUT_MS = 180000;

/** Default interpreter used to run the publisher script. */
const DEFAULT_PYTHON = "C:/Users/yuehancn/.workbuddy/binaries/python/versions/3.13.12/python.exe";

/** Default location of the proven publisher script. */
const DEFAULT_SCRIPT = "C:/Users/yuehancn/.workbuddy/skills/gzh-auto-publisher/scripts/gzh_auto.py";

/** Default location of the account registry. */
const DEFAULT_ACCOUNTS = "C:/Users/yuehancn/.workbuddy/skills/gzh-auto-publisher/accounts.json";

const Config = z.object({
	/** Absolute path to the gzh_auto.py publisher script. */
	scriptPath: z.string().default(DEFAULT_SCRIPT),
	/** Python interpreter that runs the script. */
	pythonPath: z.string().default(DEFAULT_PYTHON),
	/** Absolute path to accounts.json. */
	accountsPath: z.string().default(DEFAULT_ACCOUNTS),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Register `gzh_accounts`. Defaults to true. */
	accounts: z.boolean().default(true),
	/** Register `gzh_validate`. Defaults to true. */
	validate: z.boolean().default(true),
	/** Register `gzh_check`. Defaults to true. */
	check: z.boolean().default(true),
	/** Register `gzh_push_draft`. Defaults to true. */
	push: z.boolean().default(true),
	/** Register `gzh_verify`. Defaults to true. */
	verify: z.boolean().default(true)
});

/* --------------------------------------------------------------- running */

/**
 * Run the publisher script and return its combined output.
 *
 * The script exits non-zero on a quality-gate failure and prints the reason on
 * stdout, so both streams are captured and returned rather than treated as an
 * exception by themselves. A genuine spawn failure (missing interpreter or
 * script) is surfaced as a thrown error with an actionable message.
 *
 * @param {string} pythonPath - interpreter to run.
 * @param {string} scriptPath - script to run.
 * @param {string[]} args - CLI arguments.
 * @param {number} timeoutMs - hard kill bound.
 * @returns {Promise<{code: number, out: string, err: string}>}
 */
function runScript(pythonPath, scriptPath, args, timeoutMs) {
	return new Promise((resolvePromise) => {
		execFile(
			pythonPath,
			[scriptPath, ...args],
			// The script writes UTF-8; Python on Windows would otherwise default
			// to the OEM code page and mangle Chinese account names and titles.
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
			(error, stdout, stderr) => {
				if (error !== null && error.code === "ENOENT") {
					resolvePromise({ code: -1, out: "", err: `cannot start "${pythonPath}"` });
					return;
				}
				if (error !== null && error.killed === true) {
					resolvePromise({ code: -2, out: stdout ?? "", err: `timed out after ${Math.round(timeoutMs / 1000)}s` });
					return;
				}
				resolvePromise({
					code: typeof error?.code === "number" ? error.code : 0,
					out: (stdout ?? "").trim(),
					err: (stderr ?? "").trim()
				});
			}
		);
	});
}

/** Assert a configured file exists, with a message naming the fix. */
async function requireFile(path, what) {
	try {
		await access(path, fsConstants.R_OK);
	} catch {
		throw new Error(`gzh: ${what} not found at "${path}". Set it in the plugin config (id: tool-gzh-publisher).`);
	}
}

/**
 * Read the account registry directly, so `gzh_accounts` works without spawning
 * Python and can report what the script would see.
 *
 * @param {string} accountsPath - absolute accounts.json path.
 * @returns {Promise<Array<object>>} projected accounts.
 */
async function readAccounts(accountsPath) {
	await requireFile(accountsPath, "accounts.json");
	let raw;
	try {
		raw = JSON.parse(await readFile(accountsPath, "utf8"));
	} catch (error) {
		throw new Error(`gzh: accounts.json is not valid JSON (${error?.message ?? error})`);
	}
	return Object.entries(raw).map(([key, value]) => ({
		name: typeof value?.name === "string" ? value.name : key,
		key,
		positioning: typeof value?.positioning === "string" ? value.positioning : "",
		keywords: Array.isArray(value?.keywords) ? value.keywords : [],
		workdir: typeof value?.workdir === "string" ? value.workdir : "",
		minCjk: typeof value?.min_cjk === "number" ? value.min_cjk : undefined,
		maxCjk: typeof value?.max_cjk === "number" ? value.max_cjk : undefined
	}));
}

/* -------------------------------------------------------------- parsing */

/**
 * Parse the script's `✅` / `❌` lines into an outcome. The script's own
 * wording is preserved in `detail` so nothing is lost in translation.
 *
 * @param {number} code - script exit code.
 * @param {string} out - stdout.
 * @param {string} err - stderr.
 * @returns {{ok: boolean, detail: string}}
 */
function classify(code, out, err) {
	if (code === -2) return { ok: false, detail: err };
	if (code === -1) return { ok: false, detail: err };
	const text = [out, err].filter((part) => part.length > 0).join("\n");
	if (code === 0 && !/❌/u.test(text)) return { ok: true, detail: text };
	return { ok: false, detail: text.length > 0 ? text : `script exited with code ${code}` };
}

/** The first line of a detail block, for one-line card titles. */
function firstLine(text) {
	const line = String(text).split("\n", 1)[0] ?? "";
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/* ---------------------------------------------------------------- tools */

function apply(ctx, config) {
	const scriptPath = resolve(config.scriptPath);
	const accountsPath = resolve(config.accountsPath);
	const pythonPath = config.pythonPath;
	const budgetMs = config.timeoutMs;

	/** Shared preflight: the script must exist before any spawn. */
	const requireScript = () => requireFile(scriptPath, "publisher script");

	/* -- gzh_accounts ------------------------------------------------------ */
	if (config.accounts) {
		ctx.tools.register(defineTool({
			name: "gzh_accounts",
			description: "List the WeChat Official Account profiles this machine can publish to, with each account's positioning, keywords and working directory.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						accounts: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									key: { type: "string", required: true },
									name: { type: "string", required: true },
									positioning: { type: "string" },
									workdir: { type: "string" },
									keywords: { type: "array", required: true, items: { type: "string" } },
									minCjk: { type: "integer" },
									maxCjk: { type: "integer" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.accounts.length === 0
						? "No WeChat Official Account profiles are configured."
						: value.accounts.map((account) => {
							const range = account.minCjk === undefined || account.maxCjk === undefined ? "" : ` [${account.minCjk}-${account.maxCjk} 字]`;
							const where = account.workdir.length === 0 ? "" : `\n    workdir: ${account.workdir}`;
							return `- ${account.name} (key: ${account.key})${range}\n    ${account.positioning}${where}`;
						}).join("\n")
				}]
			},
			timeoutMs: 15000,
			isConcurrencySafe: () => true,
			async execute() {
				return { accounts: await readAccounts(accountsPath) };
			},
			presentCall: () => ({ card: "generic", title: "WeChat accounts", kind: "other", rawInput: {} })
		}));
	}

	/* -- gzh_validate ------------------------------------------------------ */
	if (config.validate) {
		ctx.tools.register(defineTool({
			name: "gzh_validate",
			description: "Check an article draft against one account's publish gate (length, formatting, title, digest) WITHOUT contacting WeChat. Use it to fix a draft before pushing.",
			parameters: {
				account: { type: "string", required: true, description: "Account key, as reported by gzh_accounts." },
				file: { type: "string", required: true, description: "Absolute path to the article markdown file." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						account: { type: "string", required: true },
						file: { type: "string", required: true },
						detail: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `${value.ok ? "PASS" : "FAIL"} — gate check for "${value.account}" on ${value.file}\n${value.detail}`
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await requireScript();
				await requireFile(args.file, "article file");
				const result = await runScript(pythonPath, scriptPath, ["validate", "--account", args.account, "--file", args.file], Math.min(budgetMs, 60000));
				const verdict = classify(result.code, result.out, result.err);
				return { ok: verdict.ok, account: args.account, file: args.file, detail: verdict.detail };
			},
			presentCall: (args) => ({ card: "generic", title: `Validate ${args.account}`, kind: "other", rawInput: args })
		}));
	}

	/* -- gzh_push_draft ---------------------------------------------------- */
	if (config.push) {
		ctx.tools.register(defineTool({
			name: "gzh_push_draft",
			description: "Push an article to one account's WeChat draft box (草稿箱). The article is validated against the account's gate first; a failing draft is not pushed. This does NOT publish — a human still clicks 发布.",
			parameters: {
				account: { type: "string", required: true, description: "Account key, as reported by gzh_accounts." },
				file: { type: "string", required: true, description: "Absolute path to the article markdown file." },
				title: { type: "string", description: "Override the auto-derived title." },
				digest: { type: "string", description: "Override the auto-derived digest (summary)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						account: { type: "string", required: true },
						file: { type: "string", required: true },
						mediaId: { type: "string" },
						detail: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ok
						? `Pushed to the WeChat draft box.\n  account: ${value.account}\n  file: ${value.file}${value.mediaId === undefined ? "" : `\n  media_id: ${value.mediaId}`}\n\n${value.detail}`
						: `Draft was NOT pushed (account "${value.account}").\n${value.detail}`
				}]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				await requireScript();
				await requireFile(args.file, "article file");
				const argv = ["push", "--account", args.account, "--file", args.file];
				if (args.title !== undefined && args.title.length > 0) argv.push("--title", args.title);
				if (args.digest !== undefined && args.digest.length > 0) argv.push("--digest", args.digest);
				const result = await runScript(pythonPath, scriptPath, argv, budgetMs);
				const verdict = classify(result.code, result.out, result.err);
				const mediaId = /media_id[=:\s]+([A-Za-z0-9_-]{10,})/u.exec(verdict.detail)?.[1];
				return {
					ok: verdict.ok,
					account: args.account,
					file: args.file,
					...mediaId === undefined ? {} : { mediaId },
					detail: verdict.detail
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Push draft: ${args.account}`, kind: "other", rawInput: args })
		}));
	}

	/* -- gzh_check --------------------------------------------------------- */
	if (config.check) {
		ctx.tools.register(defineTool({
			name: "gzh_check",
			description: "Health-check one WeChat Official Account's configuration on this machine: required fields, on-disk paths, and whether its env file carries WECHAT_APPID/WECHAT_APPSECRET. Offline; touches no network.",
			parameters: {
				account: { type: "string", required: true, description: "Account key, as reported by gzh_accounts." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						account: { type: "string", required: true },
						detail: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `${value.ok ? "Config OK" : "Config PROBLEM"} for "${value.account}":\n${value.detail}`
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await requireScript();
				const result = await runScript(pythonPath, scriptPath, ["check", "--account", args.account], Math.min(budgetMs, 60000));
				const verdict = classify(result.code, result.out, result.err);
				return { ok: verdict.ok, account: args.account, detail: verdict.detail };
			},
			presentCall: (args) => ({ card: "generic", title: `Check config: ${args.account}`, kind: "other", rawInput: args })
		}));
	}

	/* -- gzh_verify -------------------------------------------------------- */
	if (config.verify) {
		ctx.tools.register(defineTool({
			name: "gzh_verify",
			description: "Perform the live WeChat credential handshake for one account (fetches an access_token). Use it when a push fails with an auth error, or to confirm credentials still work before scheduling unattended publishing. This is the only tool here that authenticates.",
			parameters: {
				account: { type: "string", required: true, description: "Account key, as reported by gzh_accounts." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						account: { type: "string", required: true },
						detail: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `${value.ok ? "Credentials verified" : "Credential FAILURE"} for "${value.account}":\n${value.detail}`
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await requireScript();
				const result = await runScript(pythonPath, scriptPath, ["verify", "--account", args.account], Math.min(budgetMs, 60000));
				const verdict = classify(result.code, result.out, result.err);
				return { ok: verdict.ok, account: args.account, detail: verdict.detail };
			},
			presentCall: (args) => ({ card: "generic", title: `Verify credentials: ${args.account}`, kind: "other", rawInput: args })
		}));
	}
}

export { Config, apply, inject, name };