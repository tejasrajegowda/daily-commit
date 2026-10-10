import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidPortWith, type AppBridge, type Bridges, type ShellBridge, type VaultBridge } from '../../src/device/androidPort.ts';
import { isQuotaFull } from '../../src/record/core.ts';

const tick = () => new Promise<void>(done => setImmediate(done));

/** Plugins that record every call and answer as Tasks 3b and 4b's do. Invented data only. */
function fakeBridges() {
  const calls: string[] = [];
  const listeners = new Map<string, () => void>();
  const files = new Map<string, string>();
  let painted: (() => void) | undefined;
  const handle = (event: string, cb: () => void) => {
    listeners.set(event, cb);
    return Promise.resolve({ remove: async () => { listeners.delete(event); } });
  };
  const vault: VaultBridge = {
    status: async () => { calls.push('status'); return { modes: ['own-code'], codeKey: 'tee' }; },
    enrol: async o => { calls.push(`enrol ${JSON.stringify(o)}`); },
    unwrap: async o => { calls.push(`unwrap ${o.mode}`); return { kind: 'Cancelled' }; },
    verifyCode: async o => { calls.push(`verifyCode ${o.code}`); return { kind: 'WrongCode', triesLeft: 4 }; },
    remove: async o => { calls.push(`remove ${o.mode}`); },
  };
  const shell: ShellBridge = {
    addListener: (event, cb) => handle(event, cb),
    drawn: async () => { calls.push('drawn'); },
    writeFile: async o => {
      if (o.path === 'tmp/full') throw Object.assign(new Error('The phone is full.'), { code: 'full' });
      files.set(o.path, o.data);
    },
    readFile: async o => ({ data: files.get(o.path) ?? null }),
    renameFile: async o => {
      const data = files.get(o.from);
      if (data === undefined) throw Object.assign(new Error('no such file'), { code: 'io' });
      files.delete(o.from);
      files.set(o.to, data);
    },
    listFiles: async o => ({ names: [...files.keys()].filter(p => p.startsWith(`${o.dir}/`)).map(p => p.slice(o.dir.length + 1)).sort() }),
    removeFile: async o => { files.delete(o.path); },
    saveFile: async o => { calls.push(`saveFile ${o.name} ${o.data}`); return { saved: true }; },
    pickFile: async () => ({ kind: 'Picked', data: 'AQID' }),
    notificationsAllowed: async () => ({ allowed: true }),
    askNotifications: async () => ({ allowed: true }),
    sleep: async o => { calls.push(`sleep ${o.ms}`); },
    timing: async o => { calls.push(`timing ${o.label} ${o.ms}`); },
    info: async () => ({ manufacturer: 'Google', sdk: 33, screenLock: true }),
  };
  const app: AppBridge = {
    addListener: (event, cb) => handle(event, cb),
    minimizeApp: async () => { calls.push('minimize'); },
  };
  const bridges: Bridges = { vault, shell, app, afterPaint: then => { painted = then; }, persist: async () => true };
  return { bridges, calls, listeners, files, paint: () => painted?.() };
}

test('the vault\'s calls cross the bridge as one object each; the master key stays text', async () => {
  const f = fakeBridges();
  const port = androidPortWith(f.bridges);
  await port.plugin.enrol('own-code', 'AAAA', '123456');
  await port.plugin.enrol('phone-lock', 'BBBB');
  assert.deepEqual(await port.plugin.status(), { modes: ['own-code'] });          // codeKey stays on the native side's report
  assert.deepEqual(await port.plugin.unwrap('fingerprint'), { kind: 'Cancelled' });
  assert.deepEqual(await port.plugin.verifyCode('000000'), { kind: 'WrongCode', triesLeft: 4 });
  await port.plugin.remove('fingerprint');
  assert.deepEqual(f.calls, ['enrol {"mode":"own-code","masterKey":"AAAA","code":"123456"}', 'enrol {"mode":"phone-lock","masterKey":"BBBB"}',
    'status', 'unwrap fingerprint', 'verifyCode 000000', 'remove fingerprint']);
});

test('the private files go as base64url and come back as bytes; a full phone is the error the record knows', async () => {
  const f = fakeBridges();
  const { files } = androidPortWith(f.bridges);
  await files.write('tmp/a.dcbak', new Uint8Array([1, 2, 3]));
  assert.equal(f.files.get('tmp/a.dcbak'), 'AQID');
  await files.rename('tmp/a.dcbak', 'backup/latest.dcbak');
  assert.deepEqual([...(await files.read('backup/latest.dcbak')) ?? []], [1, 2, 3]);
  assert.equal(await files.read('backup/none.dcbak'), undefined);
  assert.deepEqual(await files.list('backup'), ['latest.dcbak']);
  await assert.rejects(files.write('tmp/full', new Uint8Array([1])), e => isQuotaFull(e));
  await assert.rejects(files.rename('tmp/none', 'tmp/other'), e => !isQuotaFull(e));
});

test('leave and resume come from the Shell; after resume the cover goes only once a frame has been drawn (C9)', async () => {
  const f = fakeBridges();
  const port = androidPortWith(f.bridges);
  let left = 0;
  let back = 0;
  const stopLeave = port.onLeave(() => { left++; });
  port.onResume(() => { back++; });
  await tick();
  f.listeners.get('leave')?.();
  f.listeners.get('resume')?.();
  assert.equal(left, 1);
  assert.equal(back, 1);
  assert.ok(!f.calls.includes('drawn'));                     // nothing drawn yet: the cover stays
  f.paint();
  await tick();
  assert.ok(f.calls.includes('drawn'));
  stopLeave();
  await tick();
  assert.equal(f.listeners.has('leave'), false);
});

test('save as and the picker hand over bytes, never a path', async () => {
  const f = fakeBridges();
  const port = androidPortWith(f.bridges);
  assert.equal(await port.saveFile?.('backup-2026-01-05.dcbak', new Uint8Array([1, 2, 3])), true);
  assert.ok(f.calls.includes('saveFile backup-2026-01-05.dcbak AQID'));
  const picked = await port.pickFile?.();
  assert.equal(picked?.kind, 'Picked');
  if (picked?.kind === 'Picked') assert.deepEqual([...picked.bytes], [1, 2, 3]);
});

test('the uptime sleep is held to what the Shell takes; timing is whole numbers only', async () => {
  const f = fakeBridges();
  const port = androidPortWith(f.bridges);
  await port.sleep?.(-5);
  await port.sleep?.(70_000);
  await port.sleep?.(12.6);
  port.timing?.('unlock', 1840.4);
  await tick();
  assert.deepEqual(f.calls, ['sleep 0', 'sleep 60000', 'sleep 13', 'timing unlock 1840']);
});

test('Back comes from @capacitor/app, and leaving is Home, never finishing the activity', async () => {
  const f = fakeBridges();
  const port = androidPortWith(f.bridges);
  let pressed = 0;
  port.onBack?.(() => { pressed++; });
  await tick();
  f.listeners.get('backButton')?.();
  port.leaveApp?.();
  await tick();
  assert.equal(pressed, 1);
  assert.deepEqual(f.calls, ['minimize']);
});

test('the phone holds device copies, and says what it is', async () => {
  const port = androidPortWith(fakeBridges().bridges);
  assert.equal(port.deviceModes, true);
  assert.equal(await port.persist?.(), true);
  assert.deepEqual(await port.info?.(), { manufacturer: 'Google', sdk: 33, screenLock: true });
});
