// The click-through test of the real app, in the screen harness. Invented data only.
// node scripts/screens/flows.mjs (after npm run screens:build) → PASS/FAIL lists, exit 1 on any FAIL.
import { harness } from './page.mjs';
import { SIZES } from './states.mjs';

const h = await harness();
const errors = [];
const ok = [];
const check = (name, cond) => (cond ? ok : errors).push(name);
const [PHONE, LAPTOP] = SIZES;
const CODE = '24681357';
const PASSPHRASE = 'CANARY harness passphrase';

/** waits for a selector to be on the page; false if it never came */
const shows = (p, sel, timeout = 8000) => p.waitForSelector(sel, { state: 'attached', timeout }).then(() => true, () => false);
const gone = (p, sel, timeout = 8000) => p.waitForSelector(sel, { state: 'detached', timeout }).then(() => true, () => false);
const typeCode = async (p, code) => { for (const k of code) await p.tap(`[data-a="pin"][data-x="${k}"]`); };

// the harness itself
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=today');
  check('the harness page draws', (await p.locator('[data-harness-ready]').count()) === 1);
  check('nothing is kept in localStorage', await p.evaluate(() => localStorage.length === 0));
}

// the lock (phone)
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=lock');
  check('phone lock: the lock screen shows once the phone answers', await shows(p, '.lk-finger'));
  await p.tap('.lk-finger');
  check('phone lock: the fingerprint key opens Today', await shows(p, '.today'));

  await h.open(p, 's=lock');
  await shows(p, '[data-a="devcred"]');
  await p.tap('[data-a="devcred"]');
  check("phone lock: the phone's PIN or pattern opens Today", await shows(p, '.today'));

  await h.open(p, 's=lock');
  await shows(p, '[data-a="lockpass"]');
  await p.tap('[data-a="lockpass"]');
  await p.fill('input.pass', 'CANARY not the passphrase');
  await p.tap('[data-a="unlock"]');
  check('a wrong passphrase says so and stays locked', await shows(p, '.lk-note') && (await p.locator('.today').count()) === 0
    && (await p.locator('.lk-note').innerText()).includes("didn't open"));
  check('the passphrase field is emptied once read', (await p.inputValue('input.pass')) === '');
  await p.fill('input.pass', PASSPHRASE);
  await p.press('input.pass', 'Enter');
  check('the passphrase (with Enter) opens Today', await shows(p, '.today', 15000));

  await h.open(p, 's=lock&v=own');
  await shows(p, '.pad');
  await typeCode(p, '24681');
  check('own code: Open stays hidden below six digits', !(await p.locator('[data-a="pinok"]').isVisible()));
  await typeCode(p, '357');
  check('own code: eight digits show eight dots', (await p.locator('.pins i.on').count()) === 8);
  await p.tap('[data-a="pinok"]');
  check('own code: the right code opens Today', await shows(p, '.today'));

  await h.open(p, 's=lock&v=own');
  await shows(p, '.pad');
  await typeCode(p, '000000');
  await p.tap('[data-a="pinok"]');
  check('own code: a wrong code says so, without a count, and clears the dots', await shows(p, '.lk-hint')
    && !/\d/.test(await p.locator('.lk-hint').innerText()) && (await p.locator('.pins i.on').count()) === 0);
  check('own code: the fingerprint key is there while its copy exists', (await p.locator('.k-bio').count()) === 1);
  await p.tap('.k-bio');
  check('own code: the fingerprint key opens Today', await shows(p, '.today'));

  await h.open(p, 's=lock&v=five');
  check('five wrong codes: the passphrase only, with the note', await shows(p, '.lk-pass') && (await p.locator('[data-a="pin"]').count()) === 0
    && (await p.locator('.lk-note').innerText()).includes('Five wrong codes'));

  await h.open(p, 's=lock&v=newfinger');
  check('a new fingerprint: the pad without the fingerprint key, with the note', await shows(p, '.pad') && (await p.locator('.k-bio').count()) === 0
    && (await p.locator('.lk-hint').innerText()).includes('new fingerprint'));

  await h.open(p, 's=lock&v=pass');
  check('no device copy: the passphrase only, and no way back to a device', await shows(p, '.lk-pass') && (await p.locator('[data-a="lockbio"]').count()) === 0);

  // RF1: leaving blanks the record at once
  await h.open(p, 's=today');
  await shows(p, '.today');
  await p.evaluate(() => window.harness.leave());
  check('leaving blanks the record: nothing of it is left in the page', await gone(p, '.today')
    && !(await p.locator('#view').innerText()).includes('Day '));
  await p.evaluate(() => window.harness.resume());
  check('coming back shows the lock', await shows(p, '.lock .lk-pass'));

  await h.open(p, 's=today');
  await shows(p, '.today');
  await p.tap('.dock button[data-x="look"]');
  check('the dock moves between sections', (await p.locator('h1.t-l').innerText()) === 'Look back'
    && (await p.locator('.dock button.on').getAttribute('data-x')) === 'look');
}

// the lock (laptop)
{
  const p = await h.page(LAPTOP, errors);
  await h.open(p, 's=lock');
  check('laptop: the passphrase only, even with a phone copy', await shows(p, '.lk-pass') && (await p.locator('.lk-finger').count()) === 0);
  await p.fill('input.pass', PASSPHRASE);
  await p.click('[data-a="unlock"]');
  check('laptop: the passphrase opens Today', await shows(p, '.today', 15000));
  check('laptop: the rail is there', await p.locator('.rail').isVisible());
  await p.click('.rail button[data-x="lock"]');
  check("laptop: the rail's Lock locks", await gone(p, '.today') && await shows(p, '.lk-pass'));
}

// the first day (phone)
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=first');
  check('first day: step 1 shows, with Restore offered', await shows(p, '.first .steps') && (await p.locator('[data-a="restore"]').count()) === 1);
  check('first day: the welcome names no condition and no therapy', !/\bOCD\b|\bERP\b/.test(await p.locator('.first').innerText()));
  await p.tap('[data-a="fstep"]');
  await p.fill('input.pass', 'short one');
  check('first day: the meter says the minimum under 15 characters', (await p.locator('[data-a="meter"]').innerText()).includes('At least 15'));
  await p.tap('[data-a="fstep"]');
  check('first day: a short passphrase is refused', (await p.locator('h1.t-l').innerText()) === 'Choose a passphrase'
    && (await p.locator('[data-a="meter"]').innerText()).includes('longer'));
  await p.fill('input.pass', 'CANARY river stone lamp cloud');
  check('first day: four words is strong', (await p.locator('[data-a="meter"]').innerText()).includes('Strong'));
  await p.tap('[data-a="fstep"]');
  check('first day: the recovery code shows as nine groups', await shows(p, '[data-a="code"]', 20000) && (await p.locator('[data-a="code"] span').count()) === 9);
  const code = (await p.locator('[data-a="code"] span').allInnerTexts()).join(' ');
  await p.tap('[data-a="fstep"]');
  await p.fill('.typeback-in', code.replace(/^./, c => (c === 'A' ? 'B' : 'A')));
  await p.tap('[data-a="finish"]');
  check('first day: a wrong type-back stays on step 4 and says so', await shows(p, '.panel.note') && (await p.locator('h1.t-l').innerText()) === 'Type it back');
  await p.fill('.typeback-in', code.toLowerCase());
  check('first day: typing back draws the groups', (await p.locator('.typeback span.done').count()) === 8);
  await p.tap('[data-a="finish"]');
  check('first day: finishing opens Today', await shows(p, '.today', 20000));
  await p.evaluate(() => window.harness.leave());
  await p.evaluate(() => window.harness.resume());
  check("first day: afterwards the phone's lock opens it", await shows(p, '.lk-finger'));
}

// restore
{
  const p = await h.page(PHONE, errors);
  const setFile = async kind => {
    const b64 = await p.evaluate(k => window.harness.backup(k), kind);
    await p.setInputFiles('input[type=file]', { name: 'backup.dcbak', mimeType: 'application/octet-stream', buffer: Buffer.from(b64, 'base64url') });
  };
  await h.open(p, 's=first&v=found');
  check('a copy Android put back leads to Restore', await shows(p, '[data-a="restore"]') && (await p.locator('h1.t-l').innerText()).includes('came back'));
  await p.tap('[data-a="restore"]');
  check('restore: the copy is already chosen', (await p.locator('.file-row').innerText()).includes('Made '));
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="restore-go"]');
  check('restore into an empty phone ends Restored', await shows(p, '[data-a="open"]', 20000));
  await p.tap('[data-a="open"]');
  check('Restored, then Open, shows the lock with the passphrase only', await shows(p, '.lk-pass'));

  for (const [kind, said, words, secret] of [['source', 'wrong', 'recovery code', 'CANARY not the passphrase'], ['newer', 'newer', 'newer version', null], ['damaged', 'damaged', 'damaged', PASSPHRASE]]) {
    await h.open(p, 's=restore');
    await shows(p, '[data-a="choose"]');
    await setFile(kind);
    if (secret) {
      await p.fill('input.pass', secret);
      await p.tap('[data-a="restore-go"]');
    }
    check(`restore says: ${said}`, await shows(p, '[data-a="restore-note"]', 20000) && (await p.locator('[data-a="restore-note"]').innerText()).toLowerCase().includes(words));
  }

  await h.open(p, 's=restore&v=replace');
  await shows(p, '[data-a="choose"]');
  check('restore from Settings: Back says Settings', (await p.locator('[data-a="back"]').innerText()).includes('Settings'));
  await setFile('mine');
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="restore-go"]');
  check("this record's own backup asks before replacing, without 'different record'", await shows(p, '[data-a="replace"]', 20000)
    && (await p.locator('[data-a="restore-note"]').count()) === 0);
  await p.tap('[data-a="leave"]');
  check('Leave it changes nothing: the record is still open', await shows(p, '.today'));

  await h.open(p, 's=restore&v=replace');
  await shows(p, '[data-a="choose"]');
  await setFile('source');
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="restore-go"]');
  check("another record's file asks first, and says so", await shows(p, '[data-a="replace"]', 20000)
    && (await p.locator('[data-a="restore-note"]').innerText()).includes('different record'));
  await p.tap('[data-a="replace"]');
  check('Replace everything ends Restored', await shows(p, '[data-a="open"]', 20000));
  await p.tap('[data-a="open"]');
  check('... and Open shows the lock', await shows(p, '.lk-pass'));
}

await h.close();
console.log(`PASS ${ok.length}\n  ${ok.join('\n  ')}`);
console.log(errors.length ? `FAIL ${errors.length}\n  ${errors.join('\n  ')}` : 'FAIL 0');
process.exitCode = errors.length ? 1 : 0;
