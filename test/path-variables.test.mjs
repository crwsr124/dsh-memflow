/**
 * dsh-memflow 0.4.0 — declared-path variable tests.
 *
 * Same harness shape as context-declaration.test.mjs: apply() against a fake
 * ctx and a real directory tree on disk. These cases pin the two built-in
 * path variables (`${device}`, `${hostname}`) and the loud-literal rule for
 * unknown `${...}` references, on the machine's real facts:
 * `/Users/cairui/PCAgent/.device` holds `MAGIT00198` and
 * `os.hostname()` is `MAGIT00198.local` — but the fixtures carry their OWN
 * `.device` files, and the no-`.device` case relies on none existing between
 * the OS temp dir and `/` (true on this machine and on any default setup).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const shortHost = os.hostname().replace(/\.local\.?$/i, '');

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

function createSession(cwd, delegationDepth = 0) {
	const events = [];
	return {
		header: { cwd, delegationDepth },
		snapshotEvents() { return events; },
		push(event) { events.push(event); },
	};
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memflow-var-'));
const write = (relative, content) => {
	const abs = path.join(root, relative);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf8');
	return abs;
};
const bootstrapTextOf = async (cwd, harness = undefined) => {
	const decision = await (harness ?? createHarness()).bootstrap(createSession(cwd));
	return decision.messages[0].content[0].text;
};

try {
	/* ---------- (a) ${device} reads the nearest .device: first non-empty line, trimmed ---------- */
	// Leading blank lines and padding prove the "first non-empty line, trim" rule;
	// the .device sits at the declaring directory itself (walk depth 0).
	write('dev/.device', '\n  TESTDEV  \n');
	write('dev/AGENT.md', 'DEVICE_IDENTITY');
	write('dev/memory/TESTDEV/identity.md', 'IDENTITY_FOR_TESTDEV');
	write('dev/memory/TESTDEV/status.md', 'STATUS_FOR_TESTDEV');
	write('dev/memory/OTHERDEV/status.md', 'WRONG_DEVICE_STATUS');
	write('dev/.dsh/context.yaml', [
		'systemPrompt:',
		'  - AGENT.md',
		'  - memory/${device}/identity.md',
		'preload:',
		'  - memory/${device}/status.md',
	].join('\n'));
	const devDir = path.join(root, 'dev');
	const dev = createHarness();
	const devSections = dev.sections(devDir).map((section) => section.text).join('\n');
	assert.match(devSections, /IDENTITY_FOR_TESTDEV/, 'systemPrompt path expands ${device} from .device');

	const devText = await bootstrapTextOf(devDir, dev);
	assert.equal(
		devText.includes(path.join(devDir, 'memory', 'TESTDEV', 'status.md')),
		true,
		'(d) preload path resolves to the per-device ABSOLUTE path',
	);
	assert.match(devText, /STATUS_FOR_TESTDEV/, 'the per-device file content is perceived');
	assert.doesNotMatch(devText, /\$\{device\}/, 'no literal variable survives in the injected path');
	assert.doesNotMatch(devText, /WRONG_DEVICE_STATUS/, 'another device\u2019s partition is not loaded');

	/* ---------- (b) no .device up the tree → hostname fallback (minus .local) ---------- */
	const fallbackDir = path.join(root, 'nodevice');
	write(`nodevice/memory/${shortHost}/status.md`, 'HOSTNAME_FALLBACK_STATUS');
	write('nodevice/.dsh/context.yaml', ['preload:', '  - memory/${device}/status.md'].join('\n'));
	const fallbackText = await bootstrapTextOf(fallbackDir);
	assert.equal(
		fallbackText.includes(path.join(fallbackDir, 'memory', shortHost, 'status.md')),
		true,
		'${device} falls back to the short host name when no .device exists',
	);
	assert.match(fallbackText, /HOSTNAME_FALLBACK_STATUS/);
	assert.equal(shortHost.includes('.'), false, 'the fallback strips the .local suffix');

	// An existing-but-empty .device is the hit: it falls back too.
	const emptyDir = path.join(root, 'emptydevice');
	write('emptydevice/.device', '\n   \n');
	write(`emptydevice/memory/${shortHost}/status.md`, 'EMPTY_DEVICE_FALLBACK');
	write('emptydevice/.dsh/context.yaml', ['preload:', '  - memory/${device}/status.md'].join('\n'));
	assert.match(await bootstrapTextOf(emptyDir), /EMPTY_DEVICE_FALLBACK/, 'an empty .device falls back to the host name');

	/* ---------- (b2) ${hostname} is always the short host name, never .device ---------- */
	const hostDir = path.join(root, 'hostdir');
	write('hostdir/.device', 'OTHERDEV');
	write(`hostdir/memory/${shortHost}/notes.md`, 'HOST_NOTES');
	write('hostdir/memory/OTHERDEV/notes.md', 'DECOY_NOTES');
	write('hostdir/.dsh/context.yaml', ['preload:', '  - memory/${hostname}/notes.md'].join('\n'));
	const hostText = await bootstrapTextOf(hostDir);
	assert.match(hostText, /HOST_NOTES/, '${hostname} resolves to the short host name');
	assert.doesNotMatch(hostText, /DECOY_NOTES/, '${hostname} must not read the ${device} partition');

	/* ---------- (c) unknown ${...} stays literal and fails loudly downstream ---------- */
	const unknownDir = path.join(root, 'unknownvar');
	write('unknownvar/.dsh/context.yaml', ['preload:', '  - memory/${nope_var}/x.md'].join('\n'));
	const unknownText = await bootstrapTextOf(unknownDir);
	assert.match(unknownText, /memory\/\$\{nope_var\}\/x\.md/, 'unknown variable keeps its literal place in the path');
	assert.match(unknownText, /无法读取/, 'the literal path is reported as unreadable, not silently dropped');

	/* ---------- env/config extra paths expand through the same choke point ---------- */
	write(`nodevice/memory/${shortHost}/extra.md`, 'ENV_EXTRA');
	const envHarness = createHarness({}, {
		DSH_CONTEXT_PRELOAD: path.join(root, 'nodevice', 'memory', '${hostname}', 'extra.md'),
	});
	const envText = await bootstrapTextOf(fallbackDir, envHarness);
	assert.match(envText, /ENV_EXTRA/, 'DSH_CONTEXT_PRELOAD paths expand variables too');

	console.log('path variable tests passed');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
