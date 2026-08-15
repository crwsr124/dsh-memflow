/**
 * dsh-memflow — MEMFLOW memory framework for DeepSeek Harness.
 *
 * Two deliverables:
 * 1. Global prompt variable `memflow_protocol` — live-reads MEMFLOW.md on every
 *    prompt assembly (file edits take effect on the next assembly, no drift).
 *    Presets reference it as {{memflow_protocol}} in their persona row.
 * 2. The `delegate` tool — spawns a MEMFLOW worker subagent with a prepared
 *    task dossier:
 *    - persona (order-0 system prompt) = the live MEMFLOW protocol,
 *    - first user message = task + dossier (project_dir + inlined context_files),
 *    - toolFilter denies delegation tools so workers cannot recurse,
 *    - three completion modes mirror the built-in subagent tool: foreground
 *      (tool result = worker's final summary), background one-shot (job id,
 *      in-session notice on settle), continuable (durable subagent id,
 *      settlement notice + report channel + send_message follow-ups).
 *
 * 🔴 ZERO @deepseek-ai dependencies are deliberate. Out-of-tree profile
 * plugins whose dependencies are ALSO composition rows (dsh-tools,
 * dsh-subagent, dsh-session, …) shadow the host row's module resolution once
 * present in the profile node_modules: the registry then runs from the
 * profile copy while the loop imports from the installation copy, their
 * Symbol identities split, and the first tool call crashes with
 * "Cannot read properties of undefined (reading 'prepare')". Everything here
 * therefore goes through injected services (ctx.tools / ctx.subagents /
 * ctx.get('jobs') / ctx.systemPrompt) and hand-rolled plain-JSON schemas.
 *
 * The protocol file must be free of `{{` sequences: substituted values are
 * never re-scanned, but section text (the persona row referencing the
 * variable) is interpolated once — the file content itself is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'dsh-memflow';
const inject = ['tools', 'subagents', 'systemPrompt'];

const DEFAULT_PROTOCOL_FILE = fileURLToPath(new URL('MEMFLOW.md', import.meta.url));
const DEFAULT_MAX_INLINE_BYTES = 32 * 1024;
// Only names that exist in the runtime registry: toolFilter denies are
// validated against registered tools, and the product providers
// (codex/claude-code) are disabled in the shipped presets, so naming them
// would fail the filter. Extend via config.denyTools when a deployment
// registers them.
const DEFAULT_DENY_TOOLS = ['subagent', 'subagent_fork', 'delegate'];

/** Read the protocol file, or null when unreadable. */
function readProtocol(protocolFile) {
	try {
		return fs.readFileSync(protocolFile, 'utf8');
	} catch {
		return null;
	}
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
	switch (result.stopReason) {
		case 'completed': return;
		case 'aborted': return 'subagent run was cancelled';
		case 'error': return 'subagent run failed';
		case 'max-tokens': return 'subagent run hit its token limit before finishing';
		case 'refusal': return 'subagent declined the task';
		default: return `subagent run ended abnormally (${String(result.stopReason)})`;
	}
}

/** Append the child's preserved partial answer to a stop-reason error. */
function withPartialText(error, output) {
	const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('');
	return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`;
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(run) {
	const [execution] = await Promise.allSettled([run.result.then((result) => {
		const error = stopReasonError(result);
		if (error !== void 0) throw new Error(withPartialText(error, result.output));
		return {
			kind: 'foreground',
			runId: run.id,
			output: result.output
		};
	})]);
	const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
	if (execution.status === 'rejected') {
		if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`);
		throw execution.reason;
	}
	if (disposal.status === 'rejected') throw disposal.reason;
	return execution.value;
}

/** Settle a background run, mapping cancellation to a killed status. */
async function settleStart(start, signal) {
	try {
		const run = await start;
		try {
			const result = await run.result;
			await run.dispose();
			return result;
		} catch (error) {
			return signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(error) };
		}
	} catch (error) {
		return signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(error) };
	}
}

/** Render text blocks from the canonical JSON block array. */
function outputValueText(values) {
	return values.filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'text' && typeof value.text === 'string').map((value) => value.text).join('');
}

const DEFAULT_MEMORY_PRIORITY = ['status', 'tasks', 'notes', 'brick_index', 'history'];
const DEFAULT_MEMORY_PER_FILE_BYTES = 8 * 1024;
const DEFAULT_MEMORY_TOTAL_BYTES = 64 * 1024;

/**
 * Mechanically load ALL .md files in a directory's memory/ root into text:
 * priority names first (framework order), every other .md file afterwards in
 * alphabetical order — any directory's own memory file set is picked up
 * without configuration. Per-file and total caps; truncated files carry a
 * path note. Returns '' when the directory has no readable memory files.
 */
function loadMemoryText(cwd, priority, perFileBytes, totalBytes) {
	const memoryDir = path.join(cwd, 'memory');
	let entries;
	try {
		entries = fs.readdirSync(memoryDir, { withFileTypes: true });
	} catch {
		return '';
	}
	const names = [];
	const seen = new Set();
	for (const name of priority) {
		if (seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	const rest = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !seen.has(entry.name.slice(0, -3)))
		.map((entry) => entry.name.slice(0, -3))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	for (const name of rest) names.push(name);
	const parts = [];
	let used = 0;
	for (const name of names) {
		if (used >= totalBytes) {
			parts.push('（其余记忆文件因总量上限未加载）');
			break;
		}
		const file = path.join(memoryDir, `${name}.md`);
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		let content;
		try {
			content = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const cap = Math.min(perFileBytes, totalBytes - used);
		if (content.length > cap) content = content.slice(0, cap) + `\n…（文件截断，完整内容见 ${file}）`;
		used += content.length;
		parts.push(`=== memory/${name}.md ===\n${content}`);
	}
	if (parts.length === 0) return '';
	return `工作目录记忆文件（固定快照，加载自 ${memoryDir}）:\n\n` + parts.join('\n\n');
}

/**
 * Assemble the task dossier: project_dir, then each context file inlined
 * (contents up to the per-file cap; larger files are listed with their path
 * so the worker reads them itself).
 */
function buildDossier(contextFiles, baseDir, projectDir, maxInlineBytes, memoryPriority, memoryPerFileBytes, memoryTotalBytes) {
	const parts = [`工作目录（项目根）: ${projectDir}`];
	const memoryText = loadMemoryText(projectDir, memoryPriority, memoryPerFileBytes, memoryTotalBytes);
	parts.push(memoryText === '' ? '默认感知（项目 memory/，机械加载）: 无（目录无 memory/ 或不可读）' : `默认感知（项目 memory/，机械加载）:\n${memoryText}`);
	if (contextFiles.length === 0) {
		parts.push('额外必读文件: 无。');
		return parts.join('\n\n');
	}
	parts.push('额外必读文件（由委派方指定，感知时优先）:');
	for (const file of contextFiles) {
		const abs = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
		try {
			const stat = fs.statSync(abs);
			if (stat.size > maxInlineBytes) {
				parts.push(`- ${abs}\n  （文件较大，未内联；开始工作前自行完整读取）`);
			} else {
				const content = fs.readFileSync(abs, 'utf8');
				parts.push(`- ${abs}\n${'='.repeat(40)}\n${content}`);
			}
		} catch (error) {
			parts.push(`- ${abs}\n  （读取失败: ${error.message}）`);
		}
	}
	return parts.join('\n\n');
}

const PRESET_ID = 'memflow';
const PRESET_NAME = '\u8bb0\u5fc6\u6d41\u6a21\u5f0f';
const STANDARD_PERSONA_BLOCK = `    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`;
const MEMFLOW_PERSONA_BLOCK = `    text: |-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

      {{memflow_protocol}}`;
/**
 * Provision the memflow preset on first activation: copy the standard preset
 * into the user authoring root, then rewrite its persona row to reference the
 * live {{memflow_protocol}} variable. The copy stays identical to standard in
 * every other way (tools included). Idempotent and non-destructive: an
 * existing preset is never touched, and every edit is best-effort with a
 * warning instead of a boot failure. Runs only where the agentPresets service
 * is mounted (web); headless deployments skip it silently.
 *
 * With `setDefault` (default true) the plugin also writes the default preset
 * through the settings service (namespace "agent-presets", {default}), so one
 * `dsh plugin add` both provisions the preset and makes it the deployment
 * default; set `setDefault: false` in the row config to keep the deployment
 * default untouched. The write is idempotent (skipped when the default
 * already names this preset).
 */
async function provisionPreset(ctx, config) {
	let presets;
	try {
		presets = ctx.get('agentPresets');
	} catch {
		return;
	}
	if (presets === void 0 || !presets.authorable) return;
	try {
		if ((await presets.list()).some((preset) => preset.id === PRESET_ID)) return;
		await presets.copy('standard', PRESET_ID, PRESET_NAME);
		const created = await presets.resolve(PRESET_ID);
		let content = fs.readFileSync(created.path, 'utf8');
		let edited = false;
		if (content.includes(STANDARD_PERSONA_BLOCK)) {
			content = content.replace(STANDARD_PERSONA_BLOCK, MEMFLOW_PERSONA_BLOCK);
			edited = true;
		} else {
			ctx.logger.warn(`dsh-memflow: standard persona block not found in copied preset; persona left untouched (protocol not wired)`);
		}
		if (edited) fs.writeFileSync(created.path, content);
		ctx.logger.info(`dsh-memflow: provisioned preset "${PRESET_ID}" (${PRESET_NAME}) with live {{memflow_protocol}} persona`);
		if (config.setDefault !== false && presets.defaultId !== PRESET_ID) {
			let settings;
			try {
				settings = ctx.get('settings');
			} catch {
				settings = void 0;
			}
			if (settings !== void 0) {
				await settings.mutate('agent-presets', [{ op: 'set', path: ['default'], value: PRESET_ID }]);
				ctx.logger.info(`dsh-memflow: default preset set to "${PRESET_ID}"`);
			} else {
				ctx.logger.warn('dsh-memflow: setDefault is enabled but the settings service is unavailable; default preset left unchanged');
			}
		}
	} catch (error) {
		ctx.logger.warn(`dsh-memflow: preset provisioning skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function apply(ctx, config = {}) {
	const protocolFile = typeof config.protocolFile === 'string' ? config.protocolFile : DEFAULT_PROTOCOL_FILE;
	const maxInlineBytes = Number.isFinite(config.maxInlineBytes) && config.maxInlineBytes >= 0 ? config.maxInlineBytes : DEFAULT_MAX_INLINE_BYTES;
	const denyTools = Array.isArray(config.denyTools) ? config.denyTools : DEFAULT_DENY_TOOLS;
	const backgroundEnabled = config.enableRunInBackground !== false;
	const continuable = config.backgroundMode === 'continuable';
	const provider = typeof config.provider === 'string' ? config.provider : 'spawn';
	const toolName = typeof config.toolName === 'string' ? config.toolName : 'delegate';
	const maxDepth = config.maxDepth ?? 1;
	if (maxDepth !== 'provider-managed' && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) throw new Error(`dsh-memflow: maxDepth must be a non-negative safe integer or 'provider-managed', got ${JSON.stringify(config.maxDepth)}`);

	const memoryBootstrap = config.memoryBootstrap !== false;
	const memoryPriority = Array.isArray(config.memoryPriority) ? config.memoryPriority : DEFAULT_MEMORY_PRIORITY;
	const memoryPerFileBytes = Number.isFinite(config.memoryPerFileBytes) && config.memoryPerFileBytes >= 0 ? config.memoryPerFileBytes : DEFAULT_MEMORY_PER_FILE_BYTES;
	const memoryTotalBytes = Number.isFinite(config.memoryTotalBytes) && config.memoryTotalBytes >= 0 ? config.memoryTotalBytes : DEFAULT_MEMORY_TOTAL_BYTES;

	// 1) Live protocol variable for presets (persona row: {{memflow_protocol}}).
	ctx.systemPrompt.variable('memflow_protocol', () => readProtocol(protocolFile) ?? '');

	// 1b) Mechanical memory bootstrap: a runtime-context snapshot injected once
	// per session and FIXED afterwards (per-agent WeakMap cache). The projection
	// then sees identical text on every later assembly, so no second snapshot is
	// appended and no CLEARED notice is emitted — the session works from its
	// initial memory snapshot; changes made by OTHER sessions do not rewrite it
	// (the session itself always knows its own writes). Scope: depth-0 agents
	// only (delegated children get their memory through the delegate dossier);
	// when the agentPresets service exists, only sessions composed from the
	// memflow preset; rosterless deployments (headless) load for every depth-0
	// session. Empty result drops the context.
	const memorySnapshots = new WeakMap();
	ctx.effect(() => ctx.systemPrompt.context({
		name: 'memflow:memory',
		order: 60,
		text: (context) => {
			if (!memoryBootstrap) return '';
			const agent = context.agent;
			if (agent === void 0) return '';
			if ((agent.session.header.delegationDepth ?? 0) > 0) return '';
			let presets;
			try {
				presets = ctx.get('agentPresets');
			} catch {
				presets = void 0;
			}
			if (presets !== void 0) {
				let joined;
				try {
					joined = presets.composedPreset(agent.ctx);
				} catch {
					joined = void 0;
				}
				if (joined !== PRESET_ID) return '';
			}
			if (memorySnapshots.has(agent)) return memorySnapshots.get(agent);
			const cwd = agent.session.header.cwd;
			const snapshot = cwd === void 0 ? '' : loadMemoryText(cwd, memoryPriority, memoryPerFileBytes, memoryTotalBytes);
			memorySnapshots.set(agent, snapshot);
			return snapshot;
		}
	}), 'dsh-memflow.context()');

	// 2) Model-facing guidance for the delegate tool.
	ctx.effect(() => ctx.systemPrompt.section({
		name: 'tool:delegate',
		order: 117,
		text: `Delegate project work with the ${toolName} tool: give the worker a complete, self-contained task prompt and list in context_files every file it must load beyond its default project-memory perception (memory files, shared conventions, device notes). Contents are inlined into the worker context up to a per-file cap. The worker runs under the MEMFLOW protocol in project_dir, maintains that project's memory/, and returns a self-contained work summary (what was done, files changed, acceptance status, leftovers). Prefer a foreground call when your next action depends on the result; prefer background for independent parallel work.`
	}), 'dsh-memflow.section()');

	// 3) The delegate tool, mounted once its provider is available.
	let disposeTool;
	const mount = (subagentProvider) => {
		if (typeof maxDepth === 'number' && !subagentProvider.capabilities.depthLimit) throw new Error(`dsh-memflow: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
		if (continuable && subagentProvider.prepareContinuable === void 0) throw new Error(`dsh-memflow: provider "${subagentProvider.name}" does not support backgroundMode: continuable`);
		const backgroundWording = backgroundEnabled ? continuable
			? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends you a notice containing its outcome and any final assistant message; send_message starts a later turn in the same child conversation. Set run_in_background: false only when your next action depends on receiving the result.'
			: ' This call waits for the result by default. Set run_in_background: true to return a job id; collect with job_output and stop with job_kill.'
			: ' This call waits for the worker and returns its result.';
		const toolDefinition = {
			name: toolName,
			description: `Delegate a task to a MEMFLOW worker subagent with a prepared context dossier. The worker is a separate agent working in its own context under the MEMFLOW memory protocol: it establishes project-memory perception before acting and returns a self-contained work summary instead of intermediate steps. Use context_files to hand it files beyond its default project-memory perception (shared conventions, other projects' memory, device notes); contents are inlined up to a per-file cap.` + backgroundWording,
			parameters: {
				type: 'object',
				properties: {
					description: {
						type: 'string',
						description: 'A short (3-5 word) description of the delegated task, for display.'
					},
					prompt: {
						type: 'string',
						description: 'The complete, self-contained task for the worker (goal, constraints, acceptance criteria). It does not share this conversation, so include everything it needs.'
					},
					context_files: {
						type: 'array',
						items: { type: 'string' },
						description: 'Paths of files to prepare for the worker, absolute or relative to this session working directory. Contents are inlined into the worker context (files above the inline cap are listed with their path so the worker reads them itself). Use it for memory files and task-relevant files beyond the worker default project-memory perception.'
					},
					project_dir: {
						type: 'string',
						description: 'The directory the worker treats as its project (default memory perception root). Defaults to this session working directory.'
					},
					run_in_background: {
						type: 'boolean',
						description: continuable ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.' : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.'
					}
				},
				required: ['description', 'prompt']
			},
			output: {
				schema: {
					oneOf: [
						{
							type: 'object',
							additionalProperties: false,
							required: ['kind', 'jobId'],
							properties: {
								kind: { type: 'string', const: 'background' },
								jobId: { type: 'string' }
							}
						},
						{
							type: 'object',
							additionalProperties: false,
							required: ['kind', 'subagentId'],
							properties: {
								kind: { type: 'string', const: 'continuable' },
								subagentId: { type: 'string' }
							}
						},
						{
							type: 'object',
							additionalProperties: false,
							required: ['kind', 'runId', 'output'],
							properties: {
								kind: { type: 'string', const: 'foreground' },
								runId: { type: 'string' },
								output: { type: 'array', items: { type: 'object' } }
							}
						}
					]
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.kind === 'background' ? `started background subagent task ${value.jobId}` : value.kind === 'continuable' ? `started subagent ${value.subagentId}` : outputValueText(value.output)
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const parent = exec.agent;
				if (!parent) throw new Error('delegate tool requires a calling agent (exec.agent was undefined)');
				const protocol = readProtocol(protocolFile);
				if (protocol === null) throw new Error(`dsh-memflow: protocol file unreadable: ${protocolFile}`);
				const baseDir = parent.session.header.cwd ?? process.cwd();
				const projectDir = path.resolve(args.project_dir !== undefined && args.project_dir !== '' ? args.project_dir : baseDir);
				const dossier = buildDossier(Array.isArray(args.context_files) ? args.context_files : [], baseDir, projectDir, maxInlineBytes, memoryPriority, memoryPerFileBytes, memoryTotalBytes);
				const promptText = `任务（由委派方指派）: ${args.description}\n\n${args.prompt}\n\n--- 委派上下文 dossier ---\n${dossier}\n--- dossier 结束 ---`;
				const persona = `You are a memflow worker subagent delegated by another agent.\n\n${protocol}`;
				const request = {
					label: args.description,
					prompt: [{ type: 'text', text: promptText }],
					parent,
					persona,
					toolFilter: { deny: denyTools },
					...(maxDepth !== 'provider-managed' ? { maxDepth } : {})
				};
				if (!backgroundEnabled && args.run_in_background === true) throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)');
				const runInBackground = backgroundEnabled ? (args.run_in_background ?? continuable) : false;
				if (continuable && runInBackground) {
					const started = await ctx.subagents.startContinuable({
						provider,
						label: args.description,
						request,
						signal: exec.signal
					});
					return { kind: 'continuable', subagentId: started.childId };
				}
				if (runInBackground) {
					const jobs = ctx.get('jobs');
					if (jobs === void 0) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
					const controller = new AbortController();
					return {
						kind: 'background',
						jobId: jobs.start({
							kind: 'subagent',
							label: args.description,
							owner: parent,
							run: () => ({
								cancel: (reason) => {
									controller.abort(reason ?? 'background subagent task killed');
								},
								done: settleStart(ctx.subagents.start(provider, {
									...request,
									signal: controller.signal
								}), controller.signal)
							})
						})
					};
				}
				return settleForegroundRun(await ctx.subagents.start(provider, {
					...request,
					signal: exec.signal
				}));
			}
		};
		disposeTool = ctx.tools.register(toolDefinition);
	};
	ctx.on('subagent/provider-added', (subagentProvider) => {
		if (subagentProvider.name === provider && disposeTool === void 0) mount(subagentProvider);
	});
	ctx.on('subagent/provider-removed', (providerName) => {
		if (providerName !== provider || disposeTool === void 0) return;
		disposeTool();
		disposeTool = void 0;
	});
	const present = ctx.subagents.getProvider(provider);
	if (present !== void 0) mount(present);
	else ctx.logger.info(`dsh-memflow: subagent provider "${provider}" not registered yet; the "${toolName}" tool will register when it appears`);

	// 4) Auto-provision the memflow preset (create-if-missing, web only).
	void provisionPreset(ctx, config);
}

export { apply, inject, name };
