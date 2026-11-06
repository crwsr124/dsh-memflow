import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

function createHarness(config) {
	let preStep;
	const ctx = {
		systemPrompt: { variable() {}, section() { return () => {}; } },
		effect(callback) { return callback(); },
		on(event, callback) { if (event === 'agent/pre-step') preStep = callback; },
		get() { return undefined; },
		logger: { info() {}, warn() {} },
		subagents: { getProvider() { return undefined; } },
		tools: { register() { return () => {}; } },
	};
	apply(ctx, { ...config });
	return async (session) => preStep(
		{ agent: { session, ctx: {} } },
		async () => ({ kind: 'accept', messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] }),
	);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memflow-v4-'));
try {
	fs.mkdirSync(path.join(root, 'memory'));
	fs.writeFileSync(path.join(root, 'memory', 'status.md'), 'V4_MEMORY_MARKER\n', 'utf8');
	const bootstrap = createHarness({});

	// 0.2.2 / format v4: durable messages must carry a producer-owned kind,
	// never the retired `kind: 'plugin'` wrapper.
	const events = [];
	const session = {
		header: { version: 4, cwd: root, delegationDepth: 0 },
		snapshotEvents() { return events.slice(); },
	};
	const decision = await bootstrap(session);
	const message = decision.messages[0];
	assert.deepEqual(message.source, { kind: 'plugin:dsh-memflow', form: 'memory-snapshot' });

	// Dedupe must accept the v4 producer kind after reload.
	events.push({ type: 'user/message', data: { source: message.source } });
	const again = await bootstrap(session);
	assert.equal(again.messages.length, 1, 'already-bootstrapped v4 session must not re-inject');

	// v3 sessions keep the legacy wrapper so a 0.1.5 host can still read them.
	const legacyEvents = [];
	const legacy = {
		header: { version: 3, cwd: root, delegationDepth: 0 },
		snapshotEvents() { return legacyEvents.slice(); },
	};
	const legacyDecision = await bootstrap(legacy);
	assert.deepEqual(legacyDecision.messages[0].source, { kind: 'plugin', plugin: 'dsh-memflow', form: 'memory-snapshot' });
	console.log('v4-message-source: ok');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
