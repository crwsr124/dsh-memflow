/**
 * dsh-memflow — per-directory context composition for DeepSeek Harness.
 *
 * 0.3.0 changes the premise. Memory and identity are no longer a PRESET a user
 * picks; they are a baseline requirement of every agent loop. A directory
 * declares who works there and what must be perceived before work starts, and
 * any session opened in that directory gets that composition mechanically — in
 * every deployment (web, headless, ACP child), with no roster involved.
 *
 * 0.4.0 adds path variables for git-shared declarations. A declaration checked
 * into a multi-device repository can point at per-device files:
 *
 *   preload:
 *     - memory/${device}/status.md
 *
 * `${device}` walks UP from the declaring directory to the first `.device`
 * file (bounded like MAX_WALK_UP) and takes its first non-empty line,
 * trimmed; with no `.device` (or an empty one) it falls back to the host
 * name minus the `.local` suffix. `${hostname}` is always that short host
 * name. Unknown `${...}` references stay LITERAL — the downstream read then
 * reports the path as unreadable, which exposes the mistake loudly instead
 * of silently rewriting it. Substitution lives inside resolveFrom, the one
 * choke point for declared and env/config-supplied paths alike, and is
 * evaluated on EVERY assembly (no cache) — matching the premise that
 * declarations are re-read each turn; `.device` is a one-line file.
 *
 * Declaration lives in `<dir>/.dsh/context.yaml`:
 *
 *   systemPrompt:            # identity / protocol — injected as prompt sections
 *     - AGENT.md
 *     - ../shared/PROTOCOL.md
 *   preload:                 # perception — injected as the first user message
 *     - memory/status.md
 *     - memory/history.md
 *   inherit: false           # default. true = also apply ancestors' declarations
 *                            #   (outermost first), for shared conventions.
 *
 * Two deliverables:
 * 1. Every `systemPrompt` file becomes an ordered prompt section whose text is
 *    re-read at each assembly, so editing the file takes effect on the next turn
 *    (no drift, no restart).
 * 2. Every `preload` file is concatenated into ONE fixed first user message,
 *    injected once per session through the agent/pre-step waterfall. Perception
 *    precedes the first task and is never re-projected.
 *
 * There is deliberately NO delegate tool. A dispatched agent is just a session
 * opened in another directory (the dispatcher sets its cwd), so it composes its
 * own identity and perception from that directory's declaration — the same code
 * path as every other session. Handing a child a prepared dossier would be a
 * second, divergent way to say the same thing.
 *
 * Legacy fallback: when a directory has no declaration, a `memory/` directory is
 * still loaded mechanically (0.2.x behavior), so existing projects keep working
 * untouched. A declaration, when present, wins — it is the explicit statement.
 *
 * Per-dispatch parameters (the dispatcher's channel). A directory declares the
 * DEFAULT identity; a dispatcher must still be able to narrow one run. An
 * out-of-process (ACP) provider may NOT pass `persona`, `outputSchema` or
 * `toolFilter` — the subagent service rejects such requests before `start` runs
 * — so the only channel that survives a process boundary is the child's
 * environment:
 *
 *   DSH_CONTEXT_IGNORE=1                 ignore declarations (pure headless)
 *   DSH_CONTEXT_FILE=<abs>               use this declaration instead of discovery
 *   DSH_CONTEXT_SYSTEM_PROMPT=<paths>    extra identity files (newline or path-sep)
 *   DSH_CONTEXT_PRELOAD=<paths>          extra perception files
 *   DSH_CONTEXT_PARAMS=<json|text>       this run's parameters, injected verbatim
 *
 * `DSH_*` is deliberately the right namespace: the harness's `scrubbedParentEnv()`
 * strips every `DSH_*` name from ambient inheritance and merges explicit env
 * layers AFTER the scrub, so a parameter handed to one child does NOT leak into
 * that child's own grandchildren. Per-dispatch stays per-dispatch.
 *
 * 🔴 ZERO @deepseek-ai dependencies are deliberate. Out-of-tree profile plugins
 * whose dependencies are ALSO composition rows (dsh-tools, dsh-subagent,
 * dsh-session, …) shadow the host row's module resolution once present in the
 * profile node_modules: the registry then runs from the profile copy while the
 * loop imports from the installation copy, their Symbol identities split, and
 * the first tool call crashes with "Cannot read properties of undefined
 * (reading 'prepare')". Everything here goes through injected services
 * (ctx.systemPrompt), a hand-rolled
 * YAML subset parser, and no imports beyond node: builtins.
 *
 * 🔴 stdout belongs to the protocol in ACP deployments. This plugin never writes
 * to stdout; diagnostics go to ctx.logger only.
 *
 * The protocol file must be free of `{{` sequences: substituted values are never
 * re-scanned, but section text is interpolated once — file content is not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const name = 'dsh-memflow';
const inject = ['systemPrompt'];

const DEFAULT_DECLARATION_FILE = path.join('.dsh', 'context.yaml');
// A declaration is a session's one chance at identity and initial perception:
// complete by default. Deployments with a known context budget opt into caps.
const DEFAULT_PER_FILE_BYTES = Number.POSITIVE_INFINITY;
const DEFAULT_TOTAL_BYTES = Number.POSITIVE_INFINITY;
// Sections land after DEPLOYMENT_PERSONA (0) and before PLAN_POLICY (500): a
// directory's protocol refines the deployment persona, it does not replace it.
const DEFAULT_SECTION_ORDER_BASE = 10;
const DEFAULT_MAX_SECTIONS = 16;
const MAX_WALK_UP = 64;
const DEFAULT_MEMORY_PRIORITY = ['history', 'brick_index', 'notes', 'status', 'tasks'];

/* ================================================================== *
 * YAML subset parser
 *
 * Hand-rolled to keep the zero-dependency rule. The declaration format is
 * deliberately small: top-level `key: scalar`, `key:` + block sequence of
 * scalars, and inline `key: [a, b]`. Anything else throws with a line number
 * rather than being silently half-read — a misread identity file is worse than
 * a loud error.
 * ================================================================== */

/** Strip one layer of matching quotes and an unquoted trailing `#` comment. */
function scalar(raw) {
	const text = raw.trim();
	if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1);
	if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
	const hash = text.indexOf(' #');
	return (hash === -1 ? text : text.slice(0, hash)).trim();
}

/** Parse the supported YAML subset into a plain object. */
function parseDeclaration(text, file) {
	const result = {};
	const lines = text.split(/\r?\n/);
	let key = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const indented = /^\s/.test(line);
		const item = line.trim().startsWith('- ') || line.trim() === '-';
		if (item) {
			if (key === null) throw new Error(`${file}:${index + 1}: sequence item outside a key`);
			if (!Array.isArray(result[key])) result[key] = [];
			const value = scalar(line.trim().slice(1));
			if (value !== '') result[key].push(value);
			continue;
		}
		if (indented) throw new Error(`${file}:${index + 1}: nested mappings are not supported`);
		const colon = line.indexOf(':');
		if (colon === -1) throw new Error(`${file}:${index + 1}: expected "key: value"`);
		key = line.slice(0, colon).trim();
		if (key === '') throw new Error(`${file}:${index + 1}: empty key`);
		const rest = line.slice(colon + 1).trim();
		if (rest === '') {
			result[key] = [];
			continue;
		}
		if (rest.startsWith('[') && rest.endsWith(']')) {
			result[key] = rest.slice(1, -1).split(',').map(scalar).filter((value) => value !== '');
			key = null;
			continue;
		}
		result[key] = scalar(rest);
		key = null;
	}
	return result;
}

/** Normalize a declared field to an array of non-empty strings. */
function asList(value) {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry !== '');
	return typeof value === 'string' && value !== '' ? [value] : [];
}

/** Interpret a YAML scalar as a boolean, falling back to a default. */
function asBoolean(value, fallback) {
	if (typeof value === 'boolean') return value;
	if (typeof value !== 'string') return fallback;
	const text = value.trim().toLowerCase();
	if (text === 'true' || text === 'yes' || text === '1') return true;
	if (text === 'false' || text === 'no' || text === '0') return false;
	return fallback;
}

/* ================================================================== *
 * Declaration discovery
 * ================================================================== */

/** Read and parse one declaration file, or null when absent/unreadable/invalid. */
function loadDeclaration(file, logger) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
	try {
		const parsed = parseDeclaration(text, file);
		return {
			file,
			// `<dir>/.dsh/context.yaml` declares for `<dir>`: relative paths resolve
			// against the declaring directory, not against `.dsh/`.
			baseDir: path.dirname(path.dirname(file)),
			systemPrompt: asList(parsed.systemPrompt ?? parsed.system_prompt ?? parsed.systemprompt),
			preload: asList(parsed.preload ?? parsed.context),
			// Default false: a directory declares its OWN identity. Inheriting by
			// default makes every nested project silently absorb its parent's
			// protocol, which is exactly the coupling per-directory identity is
			// meant to remove. Opt in when sharing conventions is the intent.
			inherit: asBoolean(parsed.inherit, false),
		};
	} catch (error) {
		// A malformed declaration must be loud but must not take the session down:
		// an agent with no identity is recoverable, a dead loop is not.
		logger?.warn(`dsh-memflow: ignoring malformed declaration ${file}: ${error.message}`);
		return null;
	}
}

/**
 * Resolve the declaration chain for a working directory: the nearest
 * declaration, plus ancestors while each declaration opts into `inherit`.
 *
 * `inherit` defaults to FALSE: a directory that declares an identity means that
 * identity, not that identity plus whatever an ancestor happens to say. Opting
 * in is the exception (shared conventions, a global agent index), so it must be
 * written down. Returned outermost-first so a subdirectory refines its ancestor
 * rather than being shadowed by it.
 */
function discoverDeclarations(cwd, fileName, discover, logger) {
	const chain = [];
	let dir = path.resolve(cwd);
	for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
		const found = loadDeclaration(path.join(dir, fileName), logger);
		if (found !== null) {
			chain.push(found);
			if (!found.inherit) break;
		} else if (chain.length === 0 && discover === 'cwd') break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return chain.reverse();
}

/* ================================================================== *
 * File loading
 * ================================================================== */

/** Return a UTF-8 prefix that never splits a surrogate pair. */
function truncateUtf8(text, maxBytes) {
	if (!Number.isFinite(maxBytes) || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
	if (end > 0 && /[\uD800-\uDBFF]$/.test(text.slice(0, end))) end -= 1;
	return text.slice(0, end);
}

/** The host name without a trailing `.local` (macOS zeroconf suffix). */
function shortHostname() {
	try {
		return os.hostname().replace(/\.local\.?$/i, '');
	} catch {
		return '';
	}
}

/**
 * Walk up from `startDir` to the FIRST `.device` file and return its first
 * non-empty line, trimmed. An existing-but-empty `.device` is the hit: it
 * yields undefined, which sends `${device}` to the host-name fallback. The
 * bound matches MAX_WALK_UP — a declaration living deeper than that could not
 * be discovered either.
 */
function readDeviceName(startDir) {
	let dir = path.resolve(startDir);
	for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
		let content;
		try {
			content = fs.readFileSync(path.join(dir, '.device'), 'utf8');
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
			continue;
		}
		const line = content.split(/\r?\n/).find((entry) => entry.trim() !== '');
		return line === undefined ? undefined : line.trim();
	}
	return undefined;
}

/**
 * Expand the two built-in path variables in a declared path. `baseDir` is the
 * declaring directory: which device this is belongs to where the declaration
 * lives, not to the session's cwd. Unknown `${...}` references stay literal —
 * no env expansion, no glob, no escaping; the declaration format stays a
 * deliberately small surface, and a typo surfaces as an unreadable path.
 */
function expandDeclaredPath(file, baseDir) {
	if (!file.includes('${')) return file;
	const hostname = shortHostname();
	return file.replace(/\$\{([^}]*)\}/g, (reference, name) => {
		if (name === 'device') return readDeviceName(baseDir) ?? hostname;
		if (name === 'hostname') return hostname;
		return reference;
	});
}

/**
 * Resolve a declared path against the declaring directory, expanding the
 * built-in path variables (see expandDeclaredPath). Absolute paths expand
 * too, so a pinned tree can still carry one per-device segment. Evaluated on
 * EVERY resolution — declarations are re-read each turn, and `.device` is a
 * one-line file; caching here would be the plugin's only stale state.
 */
function resolveFrom(baseDir, file) {
	const expanded = expandDeclaredPath(file, baseDir);
	return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

/**
 * Read one file for injection. Unreadable and over-cap files still produce a
 * note carrying the absolute path, so the model is never told a file was
 * perceived when it was not — it can read the rest itself.
 */
function readForInjection(abs, perFileBytes, remainingBytes) {
	let stat;
	try {
		stat = fs.statSync(abs);
	} catch (error) {
		return { text: `（无法读取: ${error.message}；路径 ${abs}）`, complete: false, bytes: 0 };
	}
	if (!stat.isFile()) return { text: `（不是文件，已跳过: ${abs}）`, complete: false, bytes: 0 };
	const cap = Math.min(perFileBytes, remainingBytes);
	if (cap <= 0) return { text: `（因总量上限未加载，完整内容见 ${abs}）`, complete: false, bytes: 0 };
	let content;
	try {
		content = fs.readFileSync(abs, 'utf8');
	} catch (error) {
		return { text: `（无法读取: ${error.message}；路径 ${abs}）`, complete: false, bytes: 0 };
	}
	const bytes = Buffer.byteLength(content, 'utf8');
	if (bytes > cap) return { text: `${truncateUtf8(content, cap)}\n…（文件截断，完整内容见 ${abs}）`, complete: false, bytes: cap };
	return { text: content, complete: true, bytes };
}

/** Split an env value holding several paths (newline first, then path separator). */
function envPaths(value) {
	if (typeof value !== 'string' || value.trim() === '') return [];
	return value
		.split('\n')
		.flatMap((line) => (line.includes(path.delimiter) ? line.split(path.delimiter) : [line]))
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
}

/* ================================================================== *
 * Legacy memory/ perception (used when a directory has no declaration)
 * ================================================================== */

/** Walk up from cwd to the first directory containing .git (project-root discovery). */
function findProjectRoot(cwd) {
	let dir = path.resolve(cwd);
	for (;;) {
		try {
			if (fs.statSync(path.join(dir, '.git')).isDirectory()) return dir;
		} catch {
			/* keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Classify a directory's memory/ state: missing / empty / ok (has .md files). */
function describeMemoryDir(cwd) {
	const memoryDir = path.join(cwd, 'memory');
	let entries;
	try {
		entries = fs.readdirSync(memoryDir, { withFileTypes: true });
	} catch {
		return 'missing';
	}
	return entries.some((entry) => entry.isFile() && entry.name.endsWith('.md')) ? 'ok' : 'empty';
}

/**
 * Mechanically load ALL .md files in a directory's memory/ root: priority names
 * first (framework order), every other .md file afterwards alphabetically — any
 * directory's own memory file set is picked up without configuration. The result
 * records completeness, so the message never claims that a limited or unreadable
 * memory file was fully perceived.
 */
function loadMemoryText(cwd, priority, perFileBytes, totalBytes) {
	const memoryDir = path.join(cwd, 'memory');
	let entries;
	try {
		entries = fs.readdirSync(memoryDir, { withFileTypes: true });
	} catch {
		return { text: '', complete: false };
	}
	const available = new Set(entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
		.map((entry) => entry.name.slice(0, -3)));
	const names = [];
	const seen = new Set();
	for (const entry of priority) {
		if (!available.has(entry) || seen.has(entry)) continue;
		seen.add(entry);
		names.push(entry);
	}
	for (const entry of [...available].filter((value) => !seen.has(value)).sort()) names.push(entry);
	const parts = [];
	let used = 0;
	let complete = true;
	for (const entry of names) {
		if (used >= totalBytes) {
			parts.push('（其余记忆文件因总量上限未加载）');
			complete = false;
			break;
		}
		const file = path.join(memoryDir, `${entry}.md`);
		const loaded = readForInjection(file, perFileBytes, totalBytes - used);
		if (!loaded.complete) complete = false;
		used += loaded.bytes;
		parts.push(`=== memory/${entry}.md ===\n${loaded.text}`);
	}
	if (parts.length === 0) return { text: '', complete: false };
	const state = complete ? '完整固定快照' : '受限固定快照（未完整加载的文件须按提示路径手动读取）';
	return {
		text: `工作目录记忆文件（${state}，加载自 ${memoryDir}）:\n\n${parts.join('\n\n')}`,
		complete,
	};
}

function apply(ctx, config = {}) {
	const fileName = typeof config.declarationFile === 'string' && config.declarationFile !== '' ? config.declarationFile : DEFAULT_DECLARATION_FILE;
	const discover = config.discover === 'cwd' ? 'cwd' : 'nearest';
	const perFileBytes = Number.isFinite(config.perFileBytes) && config.perFileBytes >= 0 ? config.perFileBytes
		: Number.isFinite(config.memoryPerFileBytes) && config.memoryPerFileBytes >= 0 ? config.memoryPerFileBytes
			: DEFAULT_PER_FILE_BYTES;
	const totalBytes = Number.isFinite(config.totalBytes) && config.totalBytes >= 0 ? config.totalBytes
		: Number.isFinite(config.memoryTotalBytes) && config.memoryTotalBytes >= 0 ? config.memoryTotalBytes
			: DEFAULT_TOTAL_BYTES;
	const sectionOrderBase = Number.isFinite(config.sectionOrderBase) ? config.sectionOrderBase : DEFAULT_SECTION_ORDER_BASE;
	const maxSections = Number.isSafeInteger(config.maxSections) && config.maxSections > 0 ? config.maxSections : DEFAULT_MAX_SECTIONS;
	const memoryPriority = Array.isArray(config.memoryPriority) ? config.memoryPriority : DEFAULT_MEMORY_PRIORITY;
	const memoryBootstrap = config.memoryBootstrap !== false;
	const legacyMemoryFallback = config.legacyMemoryFallback !== false;
	// An in-process child (spawn/fork) inherits the parent's cwd and is a session
	// like any other, so by default it composes that directory's context too.
	const skipDelegated = config.skipDelegated === true || config.includeDelegated === false;
	const allowEnvOverride = config.allowEnvOverride !== false;
	// suppressRoots keeps its 0.2.x meaning (a project root that carries its own
	// agent protocol), matched by .git project root OR by path containment.
	const suppressRoots = (Array.isArray(config.suppressRoots) ? config.suppressRoots : []).map((root) => path.resolve(root));

	const env = allowEnvOverride ? process.env : {};
	const ignoreDeclaration = config.ignoreDeclaration === true || env.DSH_CONTEXT_IGNORE === '1' || env.DSH_CONTEXT_IGNORE === 'true';
	const explicitFile = typeof env.DSH_CONTEXT_FILE === 'string' && env.DSH_CONTEXT_FILE !== '' ? env.DSH_CONTEXT_FILE : undefined;
	const extraSystemPrompt = envPaths(env.DSH_CONTEXT_SYSTEM_PROMPT).concat(asList(config.systemPrompt));
	const extraPreload = envPaths(env.DSH_CONTEXT_PRELOAD).concat(asList(config.preload));
	const dispatchParams = typeof env.DSH_CONTEXT_PARAMS === 'string' && env.DSH_CONTEXT_PARAMS.trim() !== '' ? env.DSH_CONTEXT_PARAMS : undefined;

	/** Whether a session working in this directory opts out entirely. */
	const isSuppressed = (cwd) => {
		if (suppressRoots.length === 0) return false;
		const resolved = path.resolve(cwd);
		if (suppressRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) return true;
		const root = findProjectRoot(resolved);
		return root !== null && suppressRoots.includes(root);
	};

	/**
	 * Resolve the effective plan for a working directory. Declaration files are
	 * re-read here, so the plan reflects the files as they are NOW — this runs
	 * inside section text providers and at bootstrap time, never cached.
	 */
	const planFor = (cwd) => {
		if (cwd === undefined || isSuppressed(cwd)) return { systemPrompt: [], preload: [], declared: false };
		const declarations = ignoreDeclaration
			? []
			: explicitFile !== undefined
				? [loadDeclaration(path.resolve(explicitFile), ctx.logger)].filter((entry) => entry !== null)
				: discoverDeclarations(cwd, fileName, discover, ctx.logger);
		const systemPrompt = [];
		const preload = [];
		for (const declaration of declarations) {
			for (const file of declaration.systemPrompt) systemPrompt.push(resolveFrom(declaration.baseDir, file));
			for (const file of declaration.preload) preload.push(resolveFrom(declaration.baseDir, file));
		}
		// Dispatch-supplied files come last: the dispatcher refines the directory's
		// default identity, so its files must be able to override.
		for (const file of extraSystemPrompt) systemPrompt.push(resolveFrom(cwd, file));
		for (const file of extraPreload) preload.push(resolveFrom(cwd, file));
		return {
			systemPrompt: [...new Set(systemPrompt)],
			preload: [...new Set(preload)],
			declared: declarations.length > 0,
		};
	};

	// 1) Identity — one prompt section per declared systemPrompt slot. Sections
	// are registered up front (the registry is not per-assembly), so a fixed
	// number of slots is registered and each resolves its own file at assembly
	// time. A slot with no file for the current session renders empty.
	for (let slot = 0; slot < maxSections; slot += 1) {
		ctx.effect(() => ctx.systemPrompt.section({
			name: `memflow:context:${slot}`,
			order: sectionOrderBase + slot,
			text: (assembly) => {
				const cwd = assembly.agent?.session?.header?.cwd;
				if (cwd === undefined) return '';
				const files = planFor(cwd).systemPrompt;
				if (slot >= files.length) return '';
				return readForInjection(files[slot], perFileBytes, totalBytes).text;
			},
		}), `dsh-memflow.section(${slot})`);
	}

	// 3) Dispatch parameters — the per-run narrowing an out-of-process provider
	// cannot deliver as `persona`. Ordered after every identity slot so it refines
	// them, and injected verbatim: the dispatcher owns this text.
	if (dispatchParams !== undefined) {
		ctx.effect(() => ctx.systemPrompt.section({
			name: 'memflow:dispatch-params',
			order: sectionOrderBase + maxSections,
			text: `本次调度参数（由调度方指定，优先于目录默认设定）:\n${dispatchParams}`,
		}), 'dsh-memflow.dispatchParams()');
	}

	// 4) Perception — ONE fixed first user message, injected once for the whole
	// session through the agent/pre-step waterfall (the channel agent-instructions
	// uses). `step` resets each turn, so the durable session log is the source of
	// truth for whether bootstrap already happened. Never re-projected: later
	// edits to memory files do not refresh it, exactly like a real perception.
	const hasBootstrap = (session) => session.snapshotEvents().some((event) =>
		event?.type === 'user/message'
			&& event.data?.source?.plugin === name
			&& (event.data.source?.form === 'context-preload' || event.data.source?.form === 'memory-snapshot'));

	const bootstrapMessageOf = (agent) => {
		if (!memoryBootstrap) return undefined;
		if (skipDelegated && (agent.session.header.delegationDepth ?? 0) > 0) return undefined;
		const cwd = agent.session.header.cwd;
		if (cwd === undefined || isSuppressed(cwd)) return undefined;
		const plan = planFor(cwd);
		if (plan.preload.length > 0) {
			const parts = [];
			let used = 0;
			for (const abs of plan.preload) {
				const loaded = readForInjection(abs, perFileBytes, totalBytes - used);
				used += loaded.bytes;
				parts.push(`=== ${abs} ===\n${loaded.text}`);
			}
			return {
				id: randomUUID(),
				role: 'user',
				content: [{ type: 'text', text: `工作目录前置上下文:\n\n${parts.join('\n\n')}` }],
				source: { kind: 'plugin', plugin: name, form: 'context-preload' },
			};
		}
		// No declaration (or an empty one): fall back to 0.2.x mechanical memory/
		// perception so existing projects keep working untouched.
		// `ignoreDeclaration` is documented as "pure headless", so it suppresses
		// this fallback too — otherwise a dispatcher asking for a bare session
		// would still get the directory's memory injected.
		if (plan.declared || !legacyMemoryFallback || ignoreDeclaration) return undefined;
		const state = describeMemoryDir(cwd);
		let text;
		if (state === 'ok') {
			const snapshot = loadMemoryText(cwd, memoryPriority, perFileBytes, totalBytes);
			if (snapshot.text === '') return undefined;
			text = snapshot.text;
		} else {
			text = state === 'missing'
				? `工作目录记忆：${path.join(cwd, 'memory')} 目录不存在（尚未初始化）。按协议在工作开始前初始化记忆骨架（见协议「目录结构」一节）。`
				: `工作目录记忆：${path.join(cwd, 'memory')} 目录存在但没有 .md 记忆文件。按协议初始化骨架文件（见协议「目录结构」一节）。`;
		}
		// 🔴 The message must carry a non-empty id: session persistence validates
		// message event shape on reload, and a missing id corrupts the session.
		return {
			id: randomUUID(),
			role: 'user',
			content: [{ type: 'text', text }],
			source: { kind: 'plugin', plugin: name, form: 'memory-snapshot' },
		};
	};

	ctx.on('agent/pre-step', async ({ agent }, next) => {
		const decision = await next();
		if (decision.kind === 'reject' || hasBootstrap(agent.session)) return decision;
		const message = bootstrapMessageOf(agent);
		if (message === undefined) return decision;
		return { ...decision, messages: [message, ...decision.messages] };
	});

	if (ignoreDeclaration) ctx.logger.info(`dsh-memflow: declaration discovery disabled (${fileName} ignored)`);
}

export { apply, inject, name };
