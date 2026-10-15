/**
 * dsh-memflow 0.3.0 — .dsh/context.yaml declaration tests.
 *
 * Drives apply() against a fake ctx and a real directory tree on disk. No
 * harness, no network: the plugin's contract is "given this directory state,
 * produce these prompt sections and this first user message", which is exactly
 * what these assertions pin down.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

/**
 * Mount the plugin on a fake ctx and return probes for both deliverables:
 * `sections(cwd)` renders every registered section for a session in cwd,
 * `bootstrap(session)` runs the agent/pre-step waterfall once.
 */
function createHarness(config = {}, env = {}) {
	const sections = [];
	let preStep;
	const warnings = [];
	const ctx = {
		systemPrompt: {
			variable() {},
			section(section) {
				sections.push(section);
				return () => {};
			},
			getSectionOrder() { return 0; },
		},
		effect(callback) { return callback(); },
		on(event, callback) {
			if (event === 'agent/pre-step') preStep = callback;
		},
		get() { return undefined; },
		logger: { info() {}, warn(message) { warnings.push(message); } },
		subagents: { getProvider() { return undefined; } },
		tools: { register() { return () => {}; } },
	};
	const saved = {};
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		apply(ctx, { enableDelegate: false, ...config });
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return {
		warnings,
		/** Render every section for a session working in cwd, in registered order. */
		sections(cwd) {
			const assembly = { agent: { session: { header: { cwd } } } };
			return sections
				.slice()
				.sort((a, b) => a.order - b.order)
				.map((section) => ({
					name: section.name,
					text: typeof section.text === 'function' ? section.text(assembly) : section.text,
				}))
				.filter((section) => section.text !== '');
		},
		async bootstrap(session) {
			return preStep(
				{ agent: { session, ctx: {} } },
				async () => ({ kind: 'accept', messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] }),
			);
		},
	};
}

/** A session stub matching the 0.1.2 surface (snapshotEvents, not .events). */
function createSession(cwd, delegationDepth = 0) {
	const events = [];
	return {
		header: { cwd, delegationDepth },
		snapshotEvents() { return events; },
		push(event) { events.push(event); },
	};
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memflow-ctx-'));
const write = (relative, content) => {
	const abs = path.join(root, relative);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf8');
	return abs;
};

// A SECOND root that never gets a declaration of its own. Cases covering
// undeclared directories must live here: `inherit` walks up, so a fixture
// placed under `root` would find root's declaration (case 3) and correctly
// count as declared — which is the opposite of what those cases test.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memflow-bare-'));
const writeBare = (relative, content) => {
	const abs = path.join(bare, relative);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf8');
	return abs;
};

try {
	/* ---------- 1. declaration drives sections + preload ---------- */
	write('agents/browser/AGENT.md', 'BROWSER_IDENTITY');
	write('agents/browser/memory/status.md', 'BROWSER_STATUS');
	write('agents/browser/.dsh/context.yaml', [
		'systemPrompt:',
		'  - AGENT.md',
		'preload:',
		'  - memory/status.md',
		'inherit: false',
	].join('\n'));

	const browserDir = path.join(root, 'agents/browser');
	const browser = createHarness();
	const browserSections = browser.sections(browserDir);
	assert.equal(browserSections.length, 1, 'exactly one identity section renders');
	assert.match(browserSections[0].text, /BROWSER_IDENTITY/);

	const browserSession = createSession(browserDir);
	const browserDecision = await browser.bootstrap(browserSession);
	const browserText = browserDecision.messages[0].content[0].text;
	assert.match(browserText, /BROWSER_STATUS/, 'preload file is injected as first user message');
	assert.equal(browserText, `工作目录前置上下文:\n\n=== ${path.join(browserDir, 'memory/status.md')} ===\nBROWSER_STATUS`);
	assert.equal(browserDecision.messages[0].source.form, 'context-preload');

	// The short heading applies to capped declarations too; file-level warnings remain.
	const limited = await createHarness({ perFileBytes: 4 }).bootstrap(createSession(browserDir));
	assert.equal(limited.messages[0].content[0].text.split('\n')[0], '工作目录前置上下文:');
	assert.match(limited.messages[0].content[0].text, /文件截断/);
	assert.equal(browserText.split('\n\n')[1].split('\n')[0], limited.messages[0].content[0].text.split('\n\n')[1].split('\n')[0], 'file list unchanged by the heading or limits');
	assert.equal(browserDecision.messages.length, 2, 'bootstrap message precedes the task');

	/* ---------- 2. injected once per session, never re-projected ---------- */
	browserSession.push({
		type: 'user/message',
		data: { source: { plugin: 'dsh-memflow', form: 'memory-snapshot' } },
	});
	write('agents/browser/memory/status.md', 'UPDATED_STATUS');
	const repeat = await browser.bootstrap(browserSession);
	assert.equal(repeat.messages.length, 1, 'second turn does not re-inject perception');
	assert.match(browserText, /BROWSER_STATUS/, 'existing snapshot remains unchanged after a file edit');
	const fresh = await browser.bootstrap(createSession(browserDir));
	assert.match(fresh.messages[0].content[0].text, /UPDATED_STATUS/, 'new session reads current files');
	browserSession.snapshotEvents()[0].data.source.form = 'context-preload';
	assert.equal((await browser.bootstrap(browserSession)).messages.length, 1, 'current source marker also prevents re-injection');
	write('agents/browser/memory/status.md', 'BROWSER_STATUS');

	/* ---------- 3. inheritance: subdirectory refines its ancestor ---------- */
	write('COORDINATOR.md', 'ROOT_PROTOCOL');
	write('.dsh/context.yaml', ['systemPrompt:', '  - COORDINATOR.md'].join('\n'));
	write('agents/writer/AGENT.md', 'WRITER_IDENTITY');
	write('agents/writer/.dsh/context.yaml', ['systemPrompt:', '  - AGENT.md', 'inherit: true'].join('\n'));

	const writerDir = path.join(root, 'agents/writer');
	const writerSections = createHarness().sections(writerDir);
	assert.deepEqual(
		writerSections.map((section) => section.text.trim()),
		['ROOT_PROTOCOL', 'WRITER_IDENTITY'],
		'ancestor first, then the more specific directory',
	);

	// inherit: false cuts the chain — browser must NOT see the root protocol.
	assert.doesNotMatch(browser.sections(browserDir).map((s) => s.text).join('\n'), /ROOT_PROTOCOL/);

	/* ---------- 4. per-dispatch env parameters ---------- */
	const extraIdentity = write('dispatch/EXTRA.md', 'EXTRA_IDENTITY');
	const extraPreload = write('dispatch/BRIEF.md', 'DISPATCH_BRIEF');
	const dispatched = createHarness({}, {
		DSH_CONTEXT_SYSTEM_PROMPT: extraIdentity,
		DSH_CONTEXT_PRELOAD: extraPreload,
		DSH_CONTEXT_PARAMS: '{"deadline":"today","budget":"2 turns"}',
	});
	const dispatchedTexts = dispatched.sections(browserDir).map((section) => section.text);
	assert.match(dispatchedTexts.join('\n'), /BROWSER_IDENTITY/, 'directory default still applies');
	assert.match(dispatchedTexts.join('\n'), /EXTRA_IDENTITY/, 'dispatch-supplied identity applies');
	assert.match(dispatchedTexts.join('\n'), /本次调度参数/, 'dispatch params section renders');
	assert.match(dispatchedTexts.join('\n'), /"deadline":"today"/, 'params are injected verbatim');
	assert.ok(
		dispatchedTexts.findIndex((text) => /本次调度参数/.test(text))
			> dispatchedTexts.findIndex((text) => /BROWSER_IDENTITY/.test(text)),
		'dispatch params come after directory identity so they refine it',
	);
	const dispatchedBootstrap = await dispatched.bootstrap(createSession(browserDir));
	assert.match(dispatchedBootstrap.messages[0].content[0].text, /DISPATCH_BRIEF/);

	/* ---------- 5. DSH_CONTEXT_IGNORE = pure headless ---------- */
	const ignored = createHarness({}, { DSH_CONTEXT_IGNORE: '1' });
	assert.equal(ignored.sections(browserDir).length, 0, 'no identity sections when ignoring declarations');
	const ignoredBootstrap = await ignored.bootstrap(createSession(browserDir));
	assert.equal(ignoredBootstrap.messages.length, 1, 'no perception injected when ignoring declarations');

	/* ---------- 6. DSH_CONTEXT_FILE replaces discovery ---------- */
	const standalone = write('elsewhere/context.yaml', ['systemPrompt:', `  - ${path.join(root, 'COORDINATOR.md')}`].join('\n'));
	const explicit = createHarness({}, { DSH_CONTEXT_FILE: standalone });
	const explicitTexts = explicit.sections(browserDir).map((section) => section.text).join('\n');
	assert.match(explicitTexts, /ROOT_PROTOCOL/);
	assert.doesNotMatch(explicitTexts, /BROWSER_IDENTITY/, 'explicit file replaces discovered declarations');

	/* ---------- 7. legacy memory/ fallback for undeclared directories ---------- */
	writeBare('legacy/memory/history.md', 'LEGACY_HISTORY');
	const legacyDir = path.join(bare, 'legacy');
	const legacyBootstrap = await createHarness().bootstrap(createSession(legacyDir));
	assert.match(legacyBootstrap.messages[0].content[0].text, /LEGACY_HISTORY/, 'undeclared directory still gets memory/');

	// A declared directory must NOT also pull in the legacy snapshot.
	write('declared-only/AGENT.md', 'DECLARED_IDENTITY');
	write('declared-only/memory/history.md', 'SHOULD_NOT_APPEAR');
	write('declared-only/.dsh/context.yaml', ['systemPrompt:', '  - AGENT.md', 'inherit: false'].join('\n'));
	const declaredOnly = await createHarness().bootstrap(createSession(path.join(root, 'declared-only')));
	assert.equal(declaredOnly.messages.length, 1, 'declaration with no preload injects no perception message');

	/* ---------- 8. truncation is honest and never splits a character ---------- */
	writeBare('big/memory/history.md', `${'中'.repeat(5000)}\nTAIL_SENTINEL`);
	const bigDir = path.join(bare, 'big');
	const capped = await createHarness({ perFileBytes: 64, totalBytes: 64 }).bootstrap(createSession(bigDir));
	const cappedText = capped.messages[0].content[0].text;
	assert.match(cappedText, /受限固定快照/);
	assert.match(cappedText, /文件截断/);
	assert.doesNotMatch(cappedText, /TAIL_SENTINEL/);
	assert.doesNotMatch(cappedText, /�/, 'no replacement character from a split surrogate');

	/* ---------- 9. missing file is reported, not silently dropped ---------- */
	write('broken/.dsh/context.yaml', ['preload:', '  - memory/nope.md'].join('\n'));
	const broken = await createHarness().bootstrap(createSession(path.join(root, 'broken')));
	assert.match(broken.messages[0].content[0].text, /无法读取/, 'unreadable preload file is disclosed');

	/* ---------- 10. malformed declaration warns instead of killing the loop ---------- */
	write('malformed/.dsh/context.yaml', 'systemPrompt:\n  nested:\n    deeper: 1\n');
	const malformed = createHarness();
	malformed.sections(path.join(root, 'malformed'));
	assert.ok(
		malformed.warnings.some((message) => /malformed declaration/.test(message)),
		'a malformed declaration produces a warning',
	);

	/* ---------- 11. an in-process child composes from its cwd like anyone else ---------- */
	// 0.3.0 dropped the delegate tool, so there is no dossier path any more: a
	// child at delegationDepth > 0 is just a session in a directory and must get
	// that directory's declared perception.
	const delegated = await createHarness().bootstrap(createSession(browserDir, 1));
	assert.equal(delegated.messages.length, 2, 'a delegated child still gets its directory perception');
	assert.match(delegated.messages[0].content[0].text, /BROWSER_STATUS/, 'and it is the cwd declaration that supplies it');

	/* ---------- 12. dispatch preload vs systemPrompt on an UNDECLARED directory ----------
	 * The legacy memory/ perception is a FALLBACK BRANCH, not an entry in the
	 * preload list: it runs only while the effective preload list is empty
	 * (`if (plan.preload.length > 0) { ...preload... }` returns first). So a
	 * dispatcher that injects a shared file through DSH_CONTEXT_PRELOAD
	 * replaces the directory's memory perception instead of adding to it —
	 * undeclared projects silently lose their own memory/. Deployments that
	 * inject a shared index into arbitrary directories must therefore use
	 * DSH_CONTEXT_SYSTEM_PROMPT.
	 */
	writeBare('legacy-with-injection/memory/notes.md', 'LEGACY_NOTES');
	const injectedIndex = write('dispatch/INDEX.md', 'INJECTED_INDEX');

	const preloadInjected = createHarness({}, { DSH_CONTEXT_PRELOAD: injectedIndex });
	const preloadBootstrap = await preloadInjected.bootstrap(createSession(path.join(bare, 'legacy-with-injection')));
	const preloadText = preloadBootstrap.messages[0].content[0].text;
	assert.match(preloadText, /INJECTED_INDEX/, 'the injected preload file is perceived');
	assert.doesNotMatch(preloadText, /LEGACY_NOTES/, 'and it suppresses the legacy memory/ fallback');

	const promptInjected = createHarness({}, { DSH_CONTEXT_SYSTEM_PROMPT: injectedIndex });
	const promptBootstrap = await promptInjected.bootstrap(createSession(path.join(bare, 'legacy-with-injection')));
	assert.match(promptBootstrap.messages[0].content[0].text, /LEGACY_NOTES/, 'system-prompt injection keeps the memory/ fallback');
	assert.match(
		promptInjected.sections(path.join(bare, 'legacy-with-injection')).map((section) => section.text).join('\n'),
		/INJECTED_INDEX/,
		'and the injected file still lands as a prompt section',
	);

	/* ---------- 13. suppressRoots opts a tree out entirely ---------- */
	const suppressed = createHarness({ suppressRoots: [root] });
	assert.equal(suppressed.sections(browserDir).length, 0, 'suppressed tree renders no sections');

	console.log('context declaration tests passed');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(bare, { recursive: true, force: true });
}
