import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { apply } = await import(process.env.MEMFLOW_TEST_MODULE ?? '../index.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memflow-agents-'));
const write=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
const cwd=path.join(root,'child');
function harness(config={}) {
 let hook; const sections=[];
 apply({systemPrompt:{section(s){sections.push(s);return ()=>{};}},effect(f){return f();},on(_,f){hook=f;},logger:{info(){},warn(){}}},{allowEnvOverride:false,...config});
 return {sections:()=>sections.map(s=>typeof s.text==='function'?s.text({agent:{session:{header:{cwd}}}}):s.text).join(''),run:async(events=[],kind='accept')=>hook({agent:{session:{header:{cwd},snapshotEvents(){return events;}}}},async()=>({kind,messages:[]}))};
}
const text=async(h=harness())=>(await h.run()).messages[0]?.content[0].text ?? '';
try {
 write('.device',`device_name: TEST\npcagent_root: '${root}'`);
 write('a/.dsh/profile.md','ALPHA_CAPABILITY'); write('b/.dsh/profile.md','BETA_CAPABILITY');
 write('a/.dsh/context.yaml','preload: [DO_NOT_READ_TARGET]\nagents: [recursive/.dsh/profile.md]');
 write('a/memory/status.md','DO_NOT_READ_MEMORY');
 write('.dsh/context.yaml','agents:\n  - ${pcagent_root}/a/.dsh/profile.md\n  - b/.dsh/profile.md');
 write('child/.dsh/context.yaml','inherit: true\nagents: [../a/./.dsh/profile.md, ../c/.dsh/profile.md]\npreload: [status.md]');
 write('c/.dsh/profile.md','GAMMA_CAPABILITY'); write('child/status.md','ORDINARY_PRELOAD');
 fs.symlinkSync(path.join(root,'a'),path.join(root,'alias'));
 let output=await text();
 assert.ok(output.indexOf('ALPHA_CAPABILITY')<output.indexOf('BETA_CAPABILITY'));
 assert.ok(output.indexOf('BETA_CAPABILITY')<output.indexOf('GAMMA_CAPABILITY'));
 assert.ok(output.indexOf('GAMMA_CAPABILITY')<output.indexOf('ORDINARY_PRELOAD'));
 assert.equal(output.match(/ALPHA_CAPABILITY/g).length,1);
 assert.equal(output, '工作目录前置上下文:\n\n' + [
  ...[['a','ALPHA_CAPABILITY'],['b','BETA_CAPABILITY'],['c','GAMMA_CAPABILITY']].map(([dir,body]) => {
   const profile=fs.realpathSync(path.join(root,dir,'.dsh/profile.md'));
   return `=== agent简介: ${profile} ===\ncwd: ${path.dirname(path.dirname(profile))}\n${body}`;
  }),
  `=== ${path.join(cwd,'status.md')} ===\nORDINARY_PRELOAD`,
 ].join('\n\n'), 'exact presentation: outer heading, canonical profile heading, cwd and body only');
 assert.doesNotMatch(output,/协作能力目录:|来源声明:|=== profile:/);
 assert.doesNotMatch(output,/DO_NOT_READ|recursive/);
 assert.equal(harness().sections(),'','profiles never enter system prompt');
 write('child/.dsh/context.yaml','inherit: true\nagents: [../alias/.dsh/profile.md]');
 const aliasOutput=await text();
 assert.equal(aliasOutput.match(/ALPHA_CAPABILITY/g).length,1,'symlink dedup');
 assert.ok(aliasOutput.includes(`=== agent简介: ${fs.realpathSync(path.join(root,'alias/.dsh/profile.md'))} ===`),'heading uses canonical profile path');
 assert.doesNotMatch(aliasOutput,/\/alias\//,'symlink spelling never enters presentation');
 const h=harness(); const initial=await h.run(); const source=initial.messages[0].source;
 assert.equal(source.form,'context-preload'); assert.ok(initial.messages[0].id);
 write('a/.dsh/profile.md','UPDATED_CAPABILITY');
 assert.equal((await h.run([{type:'user/message',data:{source}}])).messages.length,0,'resume keeps original snapshot');
 assert.match(await text(h),/UPDATED_CAPABILITY/,'fresh sees edited profile');
 for(const form of ['context-preload','memory-snapshot']) assert.equal((await h.run([{type:'user/message',data:{source:{plugin:'dsh-memflow',form}}}])).messages.length,0);
 assert.equal((await h.run([],'reject')).messages.length,0);
 write('child/.dsh/context.yaml','agents: []');
 assert.equal(await text(), '', 'empty agents array means no dependencies and no bootstrap catalog');
 write('child/.dsh/context.yaml','agents: []\npreload: [status.md]');
 assert.match(await text(), /ORDINARY_PRELOAD/);
 assert.doesNotMatch(await text(), /协作能力目录|声明错误/);
 write('child/.dsh/context.yaml','inherit: true\nagents: []');
 assert.match(await text(), /UPDATED_CAPABILITY/, 'empty child list preserves inherited dependencies');
 write('empty/.dsh/profile.md','  \n');
 for(const [value,expected] of [['profile.md',/必须为 profile 文件路径数组/],['[""]',/agents\[0\].*非空/],['[null, true, 123, ""]',/agents\[0\].*非空/],['[../missing/.dsh/profile.md]',/无法读取/],['[../empty/.dsh/profile.md]',/profile 为空/],['[../empty]',/路径必须/],['[../a/profile.md]',/路径必须/],['[../alias.md]',/路径必须/],['[${typo}/.dsh/profile.md]',/Unknown path variable/]]) {
  write('child/.dsh/context.yaml',`agents: ${value}`);
  assert.match(await text(),expected,value);
 }
 write('child/.dsh/context.yaml','agents:\n  -\n  - false'); assert.match(await text(),/agents\[0\]/);
 write('arbitrary.md','INVALID_ALIAS_TARGET');
 fs.mkdirSync(path.join(root,'badalias/.dsh'),{recursive:true});
 fs.symlinkSync(path.join(root,'arbitrary.md'),path.join(root,'badalias/.dsh/profile.md'));
 write('child/.dsh/context.yaml','agents: [../badalias/.dsh/profile.md]');
 assert.match(await text(),/路径必须/,'real target must also be a .dsh/profile.md');
 fs.mkdirSync(path.join(root,'directory/.dsh/profile.md'),{recursive:true});
 write('child/.dsh/context.yaml','agents: [../directory/.dsh/profile.md]');
 assert.match(await text(),/不是文件/);
 write('child/.dsh/context.yaml','agents: [../a/.dsh/profile.md]');
 assert.doesNotMatch(await text(),/BETA_CAPABILITY/,'inherit false isolates ancestor');
 assert.match(await text(harness({perFileBytes:3})),/文件截断/);
 assert.match(await text(harness({totalBytes:0})),/总量上限/);
 // The ACP clean/normal patch sets ignoreDeclaration and allowEnvOverride false.
 // Instrument actual reads to prove no declaration, device, or profile is read.
 for (const mode of ['clean','normal']) {
  const reads=[]; const original=fs.readFileSync;
  fs.readFileSync=(file,...args)=>{reads.push(String(file));return original(file,...args);};
  try { const isolated=harness({ignoreDeclaration:true,legacyMemoryFallback:false}); assert.equal(isolated.sections(),''); assert.equal(await text(isolated),''); assert.deepEqual(reads,[],mode); }
  finally {fs.readFileSync=original;}
 }
 assert.equal(await text(harness({memoryBootstrap:false})), '');
 console.log('agents catalog inheritance/order/dedup/diagnostics/snapshot/isolation tests passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
