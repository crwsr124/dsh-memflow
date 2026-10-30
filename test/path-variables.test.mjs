import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { apply } = await import(process.env.MEMFLOW_TEST_MODULE ?? '../index.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memflow-device-'));
const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); return file; };
function harness(config = {}) {
 const sections = []; let hook;
 apply({systemPrompt:{section(s){sections.push(s);return ()=>{};}}, effect(f){return f();}, on(_,f){hook=f;}, logger:{info(){},warn(){}}}, {allowEnvOverride:false,...config});
 return {sections: () => sections.map(s => typeof s.text === 'function' ? s.text({agent:{session:{header:{cwd:root}}}}) : s.text).join('\n'), async text(){const d=await hook({agent:{session:{header:{cwd:root},snapshotEvents(){return [];}}}},async()=>({kind:'accept',messages:[]})); return d.messages[0]?.content[0].text ?? '';}};
}
const device = (name='TESTDEV', dir=root) => `device_name: ${name}\npcagent_root: '${dir}'\n`;
try {
 write('.device', device());
 write('memory/TESTDEV/status.md', 'DEVICE_STATUS');
 write('identity.md', 'DEVICE_IDENTITY');
 write('.dsh/context.yaml', 'systemPrompt: [${pcagent_root}/identity.md]\npreload: [memory/${device_name}/status.md]');
 const h=harness();
 assert.match(h.sections(), /DEVICE_IDENTITY/);
 assert.match(await h.text(), /DEVICE_STATUS/);
 write('memory/NEXT/status.md','NEXT_STATUS'); write('.device',device('NEXT'));
 assert.match(await h.text(), /NEXT_STATUS/, 'device reread at next bootstrap');
 for (const [content, expected] of [
  ['OLD_SINGLE_LINE', /expected "key: value"/],
  ['', /device_name must/],
  ['device_name: TESTDEV', /pcagent_root must/],
  [`device_name: true\npcagent_root: '${root}'`, /device_name must/],
  [`device_name: 123\npcagent_root: '${root}'`, /device_name must/],
  [`device_name: [x]\npcagent_root: '${root}'`, /device_name must/],
  [device('../bad'), /single directory/], [device('bad\\name'), /single directory/],
  [device('CON'), /single directory/], [device('bad.'), /single directory/],
  [device('ok','relative'), /must be absolute/],
  [device('ok',path.join(root,'missing')), /not accessible/],
  [device('ok',path.join(root,'identity.md')), /not accessible/],
  [device()+'extra: value', /unknown device field/],
 ]) { write('.device',content); assert.match(await h.text(),expected,content); }
 fs.unlinkSync(path.join(root,'.device'));
 assert.match(await h.text(), /No .device found/);
 write('.device', device());
 for (const variable of ['device','unknown','']) {
  write('.dsh/context.yaml',`preload: [memory/\${${variable}}/status.md]`);
  assert.match(await h.text(), /Unknown path variable/);
 }
 write('.dsh/context.yaml', 'preload: [memory/${hostname}/status.md]');
 write(`memory/${os.hostname().replace(/\.local\.?$/i,'')}/status.md`, 'HOST_STATUS');
 write('.device', 'legacy-but-unused'); assert.match(await h.text(), /HOST_STATUS/);
 write('.device',device());
 write('.dsh/context.yaml','preload: [memory/${device_name}/status.md]');
 assert.match(await harness({preload:['${pcagent_root}/identity.md']}).text(),/DEVICE_IDENTITY/);
 console.log('strict YAML device and path variable tests passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
