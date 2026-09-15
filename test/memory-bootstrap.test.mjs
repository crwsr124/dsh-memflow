import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

function createHarness(config) {
	let preStep;
	const ctx = {
		systemPrompt: {
			variable() {},
			section() { return () => {}; }
		},
		effect(callback) { return callback(); },
		on(event, callback) {
			if (event === 'agent/pre-step') preStep = callback;
		},
		get() { return undefined; },
		logger: { info() {}, warn() {} },
		subagents: { getProvider() { return undefined; } },
		tools: { register() { return () => {}; } }
	};
	apply(ctx, { ...config });
	return async (session) => preStep(
		{ agent: { session, ctx: {} } },
		async () => ({ kind: 'accept', messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] })
	);
}

// 0.3.0 reads the transcript through `session.snapshotEvents()` rather than a
// bare `events` array, so fixtures have to expose the same shape the harness does.
function createSession(cwd) {
	const events = [];
	return {
		header: { cwd, delegationDepth: 0 },
		events,
		snapshotEvents() { return events.slice(); }
	};
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memflow-test-'));
try {
	const memory = path.join(root, 'memory');
	fs.mkdirSync(memory);
	fs.writeFileSync(path.join(memory, 'history.md'), `${'中'.repeat(5_000)}\nTAIL_SENTINEL`, 'utf8');

	const fullBootstrap = createHarness({});
	const fullSession = createSession(root);
	const fullDecision = await fullBootstrap(fullSession);
	const fullText = fullDecision.messages[0].content[0].text;
	assert.match(fullText, /完整固定快照/);
	assert.match(fullText, /TAIL_SENTINEL/);
	assert.doesNotMatch(fullText, /文件截断/);

	fullSession.events.push({
		type: 'user/message',
		data: { source: { plugin: 'dsh-memflow', form: 'memory-snapshot' } }
	});
	const dedupedDecision = await fullBootstrap(fullSession);
	assert.equal(dedupedDecision.messages.length, 1);

	const limitedBootstrap = createHarness({ memoryPerFileBytes: 64, memoryTotalBytes: 64 });
	const limitedSession = createSession(root);
	const limitedDecision = await limitedBootstrap(limitedSession);
	const limitedText = limitedDecision.messages[0].content[0].text;
	assert.match(limitedText, /受限固定快照/);
	assert.match(limitedText, /文件截断/);
	assert.doesNotMatch(limitedText, /TAIL_SENTINEL/);
	assert.doesNotMatch(limitedText, /\uFFFD/);

	console.log('memory bootstrap tests passed');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
