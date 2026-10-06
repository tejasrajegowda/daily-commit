// The click-through test of the real app, in the screen harness. Invented data only.
// node scripts/screens/flows.mjs (after npm run screens:build) → PASS/FAIL lists, exit 1 on any FAIL.
import { harness } from './page.mjs';
import { SIZES } from './states.mjs';
import { screenProblems } from './rules.mjs';

const h = await harness({ rules: true });
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

// the wellbeing-rules check itself, on three pages made for it
{
  const p = await h.page(PHONE, errors);
  const page = body => p.setContent(`<!doctype html><body style="background:#000;color:#ddd"><div id="app">${body}</div><div id="layer"></div></body>`);
  await page('<p>Walk · 5 of the last 7 days</p><button class="btn--delete" style="background:oklch(.56 .17 25)">Move to trash</button>');
  check('rules check: a clean page, with the diary delete in red, passes', (await screenProblems(p)).length === 0);
  await page('<p>A 12-day streak</p>');
  check('rules check: a banned word is found', (await screenProblems(p)).some(x => x.includes('"streak"')));
  await page('<p>Walk <span style="color:oklch(.6 .2 25)">not done</span></p>');
  check('rules check: red outside the delete is found', (await screenProblems(p)).some(x => x.startsWith('red outside')));
  check('rules check: every flow step is swept', typeof p.sweep === 'function');
}

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

  await h.open(p, 's=lock');
  await shows(p, '[data-a="lockpass"]');
  await p.tap('[data-a="lockpass"]');
  await p.tap('[data-a="usecode"]');
  check('the lock offers the recovery code instead of the passphrase', await shows(p, 'input[aria-label="Recovery code"]'));
  await p.fill('input.pass', 'ABCDE ABCDE ABCDE ABCDE ABCDE ABCDE ABCDE ABCDE A');
  await p.tap('[data-a="unlock"]');
  check('a wrong recovery code says so and stays locked', await shows(p, '.lk-note') && (await p.locator('.today').count()) === 0);
  const paperCode = await p.evaluate(() => window.harness.recoveryCode);
  await p.fill('input.pass', paperCode.toLowerCase().replace(/ /g, ''));
  await p.tap('[data-a="unlock"]');
  check('the recovery code from paper opens Today (spaces and case forgiven)', await shows(p, '.today', 15000));

  await h.open(p, 's=lock&v=own');
  await shows(p, '.pad');
  check('own code: the keypad starts with six empty dots', (await p.locator('.pins i').count()) === 6 && (await p.locator('.pins i.on').count()) === 0);
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
  await p.fill('.lk-pass input', 'CANARY not the passphrase');
  await p.press('.lk-pass input', 'Enter');
  const noted = await shows(p, '.lk-note', 15000);
  await p.evaluate(() => window.harness.leave());
  await p.evaluate(() => window.harness.resume());
  check('a wrong passphrase, then a leave: coming back shows the lock with no note from before', noted && await shows(p, '.lk-pass') && await gone(p, '.lk-note'));

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
  check('the dock moves between sections', (await p.locator('.scr .eb').first().innerText()).toUpperCase() === 'LOOK BACK'
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
  const checkRow = await p.evaluate(() => {
    const box = document.querySelector('[data-a="code"]').getBoundingClientRect();
    const spans = [...document.querySelectorAll('[data-a="code"] span')].map(s => s.getBoundingClientRect());
    const last = spans[8], rows = new Set(spans.slice(0, 8).map(r => Math.round(r.top)));
    return rows.size === 2 && last.top >= Math.max(...spans.slice(0, 8).map(r => r.bottom))
      && Math.abs((last.left + last.right) / 2 - (box.left + box.right) / 2) < 4;
  });
  check('first day: the eight groups fill two rows and the check symbol has its own, centred', checkRow);
  check('first day: the note under the code promises only what every code keeps (the check symbol can be U)',
    (await p.locator('[data-a="code"] + p').innerText()).startsWith('No I, L or O anywhere'));
  await p.tap('[data-a="fstep"]');
  check('first day: the type-back field is a password field, so the keyboard keeps nothing', (await p.getAttribute('.typeback-in', 'type')) === 'password');
  check('first day: before typing, every place in the type-back shows its dots',
    ((await p.locator('.typeback').innerText()).match(/·····/g) ?? []).length === 8);
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
  await h.open(p, 's=restore');
  await shows(p, '[data-a="choose"]');
  await p.setInputFiles('input[type=file]', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a backup at all') });
  const notBackup = await shows(p, '[data-a="restore-note"]') ? (await p.locator('[data-a="restore-note"]').innerText()).toLowerCase() : '';
  check("restore says a file that isn't a backup is not one, not that it's damaged", notBackup.includes("isn't a daily commit backup") && !notBackup.includes('damaged'));

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
  await p.fill('input.pass', 'CANARY not the source passphrase either');
  await p.tap('[data-a="restore-go"]');
  check("another record's file with a wrong passphrase says 'a different record', not 'wrong'",
    await shows(p, '[data-a="restore-note"]', 20000) && (await p.locator('[data-a="restore-note"]').innerText()).includes('different record'));

  await h.open(p, 's=restore&v=replace');
  await shows(p, '[data-a="choose"]');
  await setFile('source');
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="restore-go"]');
  check("another record's file asks first, and says so", await shows(p, '[data-a="replace"]', 20000)
    && (await p.locator('[data-a="restore-note"]').innerText()).includes('different record'));
  await p.tap('[data-a="replace"]');
  check('while it replaces, Back is closed as well as Leave it', await p.isDisabled('[data-a="back"]') && await p.isDisabled('[data-a="leave"]'));
  check('Replace everything ends Restored', await shows(p, '[data-a="open"]', 20000));
  await p.tap('[data-a="open"]');
  check('... and Open shows the lock', await shows(p, '.lk-pass'));

  // R1-4: a replace whose safety copy can't be written says so, and its one way on is the lock screen
  for (const [why, title, words] of [['other', 'Not replaced', "couldn't be saved first"], ['full', 'The phone is full', 'free some space']]) {
    await h.open(p, 's=restore&v=replace');
    await shows(p, '[data-a="choose"]');
    await setFile('source');
    await p.fill('input.pass', PASSPHRASE);
    await p.tap('[data-a="restore-go"]');
    await shows(p, '[data-a="replace"]', 20000);
    await p.evaluate(w => window.harness.failCopy(w), why);
    await p.tap('[data-a="replace"]');
    const said = await shows(p, '[data-a="restore-stopped"]', 20000) ? (await p.locator('[data-a="restore-stopped"]').innerText()).toLowerCase() : '';
    check(`a replace that can't keep its copy (${why}) says so: '${title}', that it's locked now, and never 'try again'`,
      said.includes(title.toLowerCase()) && said.includes(words) && said.includes('locked now') && !said.includes('try again'));
    check(`... (${why}) and asks nothing again: no Replace everything is offered`, (await p.locator('[data-a="replace"]').count()) === 0);
    if (await shows(p, '[data-a="open"]', 2000)) await p.tap('[data-a="open"]');
    check(`... (${why}) and Open leads to the lock screen`, await shows(p, '.lk-finger, .lk-pass') && (await p.locator('[data-a="restore-stopped"]').count()) === 0);
  }

  // R1-2: a record that can't be opened offers Restore from its note; a replace ends at its lock screen.
  // Every step taps only what is there, so a missing way on fails the checks rather than the run.
  const tapIf = async sel => { if (!(await shows(p, sel, 3000))) return false; await p.tap(sel); return true; };
  const noteOf = async () => (await shows(p, '[data-a="restore-note"]', 20000) ? (await p.locator('[data-a="restore-note"]').innerText()).toLowerCase() : '');
  const askFromLock = async () => {
    if (!(await tapIf('[data-a="lockrestore"]')) || !(await shows(p, '[data-a="choose"]'))) return '';
    await setFile('mine');
    await p.fill('input.pass', PASSPHRASE);
    await p.tap('[data-a="restore-go"]');
    return await shows(p, '[data-a="replace"]', 20000) ? (await p.locator('.center-col').innerText()) : '';
  };
  const unlockWith = async secret => {
    if (!(await shows(p, '.lk-pass'))) return;
    await p.fill('input.pass', secret);
    await p.tap('[data-a="unlock"]');
  };
  await h.open(p, 's=lock&v=damaged');
  check("a record that can't be opened says so, and its note offers Restore", await shows(p, '[data-a="lockrestore"]', 15000)
    && (await p.locator('.lk-note').innerText()).toLowerCase().includes("can't be opened"));
  await tapIf('[data-a="lockrestore"]');
  check('... Restore opens from it, and its Back says Back, not Settings', await shows(p, '[data-a="choose"]', 3000)
    && (await p.locator('[data-a="back"]').innerText()).includes('Back') && !(await p.locator('[data-a="back"]').innerText()).includes('Settings'));
  await tapIf('[data-a="back"]');
  check('... Back returns to the lock screen, its note still there', await shows(p, '.lk-pass') && await shows(p, '[data-a="lockrestore"]', 3000)
    && (await p.locator('[data-a="choose"]').count()) === 0);
  const asked = await askFromLock();
  check("... the file and passphrase are checked first, then it asks, saying the record on this phone can't be opened and is replaced",
    asked.includes("can't be opened") && asked.includes('replaces all of it'));
  await tapIf('[data-a="replace"]');
  check('... Replace everything ends Restored', await shows(p, '[data-a="open"]', 20000));
  await tapIf('[data-a="open"]');
  check('... then Open shows the lock screen with no note, never the record', await shows(p, '.lk-pass')
    && (await p.locator('.lk-note').count()) === 0 && (await p.locator('.today').count()) === 0);
  await unlockWith(PASSPHRASE);
  check('... and the passphrase opens the restored record', await shows(p, '.today', 15000));

  await h.open(p, 's=lock&v=damaged');
  await shows(p, '.lk-note', 15000);
  await askFromLock();
  await p.evaluate(() => window.harness.failCopy('other'));
  await tapIf('[data-a="replace"]');
  const failed = await noteOf();
  check("a replace of it that fails says 'Not replaced' and that the record is as it was", failed.includes('not replaced') && failed.includes('as it was'));
  await tapIf('[data-a="back"]');
  await unlockWith(PASSPHRASE);
  check("... and the record is the one that was there: it still says it can't be opened, with Restore", await shows(p, '[data-a="lockrestore"]', 15000)
    && (await p.locator('.today').count()) === 0);
}

// Today
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  const valOf = id => p.locator(`.row[data-x="${id}"] .val`).innerText();
  // a step a screen can't offer is skipped, so the checks after it fail instead of stopping the run
  const tapIf = async sel => { if (!(await shows(p, sel, 3000))) return false; await p.tap(sel); return true; };
  const fillIf = async (sel, value) => { if (!(await shows(p, sel, 3000))) return false; await p.fill(sel, value); return true; };
  await h.open(p, 's=today&t=06:05');
  await shows(p, '.today .row');
  await p.tap('.row[data-x="h-wake"]');
  check('Today: tapping an empty time row records now', await until(() => document.querySelector('.row[data-x="h-wake"] .val')?.textContent?.includes('06:05')));
  await p.tap('.row[data-x="h-plan"]');
  check('Today: a three-way row opens three choices', (await p.locator('.row[data-x="h-plan"] .opt').count()) === 3);
  await p.tap('.row[data-x="h-plan"] .opt >> text=Partly');
  check('Today: a choice sets partly', await until(() => document.querySelector('.row[data-x="h-plan"]')?.getAttribute('data-s') === 'partly'));
  await p.tap('[data-a="sheet"]');
  check("Today: the not-today sheet opens", await shows(p, '.sheet[role="dialog"]'));
  await p.tap('[data-a="nt"][data-x="h-walk"]');
  await p.tap('[data-a="sheet-ok"]');
  check('Today: planning one marks it planned rest', await until(() => document.querySelector('.row[data-x="h-walk"]')?.getAttribute('data-s') === 'planned')
    && (await valOf('h-walk')).includes('planned rest') && (await p.locator('.sheet').count()) === 0);
  check('Today: the morning shows nothing written on an earlier day', !(await p.locator('#intent').inputValue()));
  await p.tap('[data-a="sheet"]');
  await shows(p, '.sheet[role="dialog"]');
  await p.evaluate(() => window.harness.leave());
  check('leaving with a sheet open leaves no sheet behind', await gone(p, '.sheet') && (await p.locator('.today').count()) === 0);

  await h.open(p, 's=today&t=21:30');
  await shows(p, '.today .mood');
  await p.tap('.mood button[data-x="4"]');
  check('Today: a mood tap sets 4', await until(() => document.querySelector('.mood button.on')?.textContent === '4'));
  await p.tap('.row[data-x="h-wake"]');
  // R2-2: in the evening an empty morning time row asks for the time; the evening clock is not stored
  check('R2-2: an empty wake-up tapped in the evening asks for the time and stores nothing yet',
    await shows(p, '.row[data-x="h-wake"] [data-a="time-at"]') && (await valOf('h-wake')).includes('—')
    && (await p.locator('.row[data-x="h-wake"] .sub').innerText()) === 'What time was it?');
  await fillIf('.row[data-x="h-wake"] [data-a="time-at"]', '07:10');
  await tapIf('.row[data-x="h-wake"] [data-a="time-save"]');
  check('R2-2: the time typed in is the one kept', await until(() => document.querySelector('.earlier .chip[data-x="h-wake"]')?.textContent?.includes('07:10')));
  check('Today: a hard evening offers the rest day', (await p.locator('[data-a="rest"]').count()) === 2);
  await p.tap('[data-a="rest"][data-x="use"]');
  check('Today: the rest day marks only the Focus still unanswered', await until(() => (document.querySelector('.earlier')?.textContent?.split('planned rest').length ?? 0) - 1 === 2)
    && !(await p.locator('.earlier').innerText()).includes('wake upplanned'));
  await tapIf('.chip[data-x="h-walk"]');
  await tapIf('.row[data-x="h-walk"] .opt >> text=Did it');
  check('R2-2: the rest day used, a Focus habit done anyway is recorded as done', await until(() => {
    const c = document.querySelector('.chip[data-x="h-walk"]');
    return c !== null && !c.classList.contains('idle') && !c.textContent?.includes('planned');
  }));
  await p.tap('[data-a="close"]');
  check("Today: That's the day closes it", await until(() => document.querySelector('h1.t-xl')?.textContent?.includes("That's the day")));
  await p.tap('[data-a="reopen"]');
  check('Today: Open today again returns to the evening', await until(() => !document.querySelector('h1.t-xl')?.textContent?.includes("That's the day")) && await shows(p, '[data-a="close"]'));

  await h.open(p, 's=today&t=10:30&age=20');
  await shows(p, '.today .row');
  check('Today: a Saturday has no weekday-only row', (await p.locator('.row[data-x="h-practice"]').count()) === 0);
  await h.open(p, 's=today&t=22:58&v=closed');
  check('Today: a closed day shows its card', await shows(p, '.closed-card'));

  // R2-7: a failed "Plan it" shows its words inside the sheet, not hidden under it
  await h.open(p, 's=today&t=06:05');
  await shows(p, '.today .row');
  await p.tap('[data-a="sheet"]');
  await shows(p, '.sheet[role="dialog"]');
  await p.tap('[data-a="nt"][data-x="h-walk"]');
  await p.evaluate(() => window.harness.failWrite());
  await p.tap('[data-a="sheet-ok"]');
  check('R2-7: a failed "Plan it" shows its words inside the sheet',
    await shows(p, '.sheet [data-a="save-note"]') && (await p.locator('[data-a="save-note"]').count()) === 1);
  await p.tap('.sheet [data-a="sheet-x"]');
  check('R2-7: leaving the sheet drops the note; it never reappears under the page', await gone(p, '.sheet')
    && (await p.locator('[data-a="save-note"]').count()) === 0);

  // R2-8: a write that throws something other than a full phone still says the save didn't go through
  await h.open(p, 's=today&t=21:30');
  await shows(p, '.today .row');
  await p.tap('.row[data-x="h-walk"]');
  await p.evaluate(() => window.harness.failWrite());
  await p.tap('.row[data-x="h-walk"] .opt >> text=Did it');
  check('R2-8: a thrown write (not a full phone) still gets the not-saved words',
    await shows(p, '[data-a="save-note"]') && (await p.locator('[data-a="save-note"]').innerText()).toLowerCase().includes('not saved'));

  // R2-13: a second tap on "That's the day" or "Open today again" landing before the first write
  // resolves is ignored outright, instead of racing it into a false "Not saved"
  await h.open(p, 's=today&t=21:30');
  await shows(p, '[data-a="close"]');
  await p.evaluate(() => { const b = document.querySelector('[data-a="close"]'); b?.click(); b?.click(); });
  check('R2-13: a doubled tap on "That\'s the day" closes once, with no false "Not saved"',
    await shows(p, '.closed-card') && (await p.locator('[data-a="save-note"]').count()) === 0);
  await p.evaluate(() => { const b = document.querySelector('[data-a="reopen"]'); b?.click(); b?.click(); });
  check('R2-13: the same for a doubled tap on "Open today again"',
    await shows(p, '[data-a="close"]') && (await p.locator('[data-a="save-note"]').count()) === 0);

  // R2-2: from 14:00 an answered or planned Focus habit is a chip, and the chip opens its row again
  await h.open(p, 's=today&t=06:05');
  await shows(p, '.today .row');
  await p.tap('[data-a="sheet"]');
  await shows(p, '.sheet[role="dialog"]');
  await p.tap('[data-a="nt"][data-x="h-walk"]');
  await tapIf('[data-a="reason"][data-x="meeting"]');
  await p.tap('[data-a="sheet-ok"]');
  await until(() => document.querySelector('.row[data-x="h-walk"]')?.getAttribute('data-s') === 'planned');
  await p.evaluate(() => window.harness.moveClock(925));   // 21:30
  check('R2-2: Walk planned "not today" in the morning is a planned-rest chip in the evening',
    await until(() => document.querySelector('.earlier .chip[data-x="h-walk"]')?.textContent?.includes('planned rest')));
  await tapIf('.chip[data-x="h-walk"]');
  check('R2-2: the chip opens its row again, with its three choices', await shows(p, '.row[data-x="h-walk"].is-open')
    && (await p.locator('.row[data-x="h-walk"] .opt').count()) === 3);
  await tapIf('.row[data-x="h-walk"] .opt >> text=Did it');
  check("R2-2: done after all, \"did\" wins over the morning's plan (B-2)", await until(() => {
    const c = document.querySelector('.chip[data-x="h-walk"]');
    return c !== null && !c.classList.contains('idle') && !c.textContent?.includes('planned');
  }) && (await p.locator('[data-a="save-note"]').count()) === 0);

  // R2-2: a mis-tap put right in the evening: "Partly" for "Did it", and a wrong wake-up time
  await h.open(p, 's=today&t=21:30');
  await shows(p, '.row[data-x="h-walk"]');
  await p.tap('.row[data-x="h-walk"]');
  await p.tap('.row[data-x="h-walk"] .opt >> text=Partly');
  await until(() => document.querySelector('.chip[data-x="h-walk"]')?.textContent?.includes('partly'));
  await tapIf('.chip[data-x="h-walk"]');
  await tapIf('.row[data-x="h-walk"] .opt >> text=Did it');
  check('R2-2: a "Partly" mis-tap is changed to "Did it" from its chip', await until(() => {
    const c = document.querySelector('.chip[data-x="h-walk"]');
    return c !== null && !c.classList.contains('idle') && !c.textContent?.includes('partly');
  }));
  await p.tap('.row[data-x="h-wake"]');
  await fillIf('.row[data-x="h-wake"] [data-a="time-at"]', '09:15');
  await tapIf('.row[data-x="h-wake"] [data-a="time-save"]');
  await until(() => document.querySelector('.chip[data-x="h-wake"]')?.textContent?.includes('09:15'));
  await tapIf('.chip[data-x="h-wake"]');
  check('R2-2: the wake-up chip opens with its time in the field', await shows(p, '.row[data-x="h-wake"] [data-a="time-at"]')
    && (await p.inputValue('.row[data-x="h-wake"] [data-a="time-at"]')) === '09:15');
  await fillIf('.row[data-x="h-wake"] [data-a="time-at"]', '06:50');
  await tapIf('.row[data-x="h-wake"] [data-a="time-save"]');
  check('R2-2: a wrong wake-up time is changed from its chip', await until(() => document.querySelector('.chip[data-x="h-wake"]')?.textContent?.includes('06:50')));
  await tapIf('.chip[data-x="h-wake"]');
  await tapIf('.row[data-x="h-wake"] [data-a="clear"]');
  check('R2-2: ... or cleared, and it is an open row again', await until(() =>
    document.querySelector('.chip[data-x="h-wake"]') === null && document.querySelector('.row[data-x="h-wake"]')?.getAttribute('data-s') === ''));

  // R2-1: words still in a field when the 14:00 switch or the new day takes it away are saved to the
  // day they were typed for, and if that save fails they stay on Today
  await h.open(p, 's=today&t=13:58');
  await shows(p, '#intent');
  await p.fill('#intent', 'CANARY-TEST a calm morning');
  await p.evaluate(() => window.harness.moveClock(3));
  check('R2-1: words in "What would make today good" at the 14:00 switch are saved to that day',
    await shows(p, '#remark') && await until(() => window.harness.dayWords(17).intent === 'CANARY-TEST a calm morning'));
  await h.open(p, 's=today&t=23:58');
  await shows(p, '#remark');
  await p.fill('#remark', 'CANARY-TEST a long day');
  await p.evaluate(() => window.harness.moveClock(4 * 60 + 3));
  check('R2-1: words in "A word about today" at 04:00 are saved to the day they were typed for, not the new one',
    await shows(p, '#intent') && await until(() => window.harness.dayWords(17).remark === 'CANARY-TEST a long day' && window.harness.dayWords(18).remark === undefined)
    && !(await p.locator('#intent').inputValue()));
  await h.open(p, 's=today&t=13:58');
  await shows(p, '#intent');
  await p.fill('#intent', 'CANARY-TEST kept words');
  await p.evaluate(() => { window.harness.failWrite(); window.harness.moveClock(3); });
  const kept = await shows(p, '[data-a="unsaved-words"]');
  check('R2-1: when that save fails, the words stay on Today with the not-saved words',
    kept && (await p.locator('[data-a="unsaved-words"]').innerText()).includes('CANARY-TEST kept words')
    && (await p.locator('[data-a="save-note"]').innerText()).toLowerCase().includes('not saved'));
  if (kept) await p.tap('[data-a="unsaved"][data-x="save"]');
  check('R2-1: Try again saves them to their day, and they leave the screen',
    kept && await gone(p, '[data-a="unsaved-words"]') && await until(() => window.harness.dayWords(17).intent === 'CANARY-TEST kept words'));

  // R2-3: a wake-up before 04:00 goes to the day ahead (B-5), from the closed card and from the
  // evening, and tonight's empty wake-up never takes it for the day before
  const ahead = '[data-a="ahead"] .row[data-x="h-wake"]';
  await h.open(p, 's=today&age=16&t=22:58&v=closed');
  await shows(p, '.closed-card');
  check('R2-3: before 03:50 nothing on the closed card asks about the day ahead', (await p.locator('[data-a="ahead"]').count()) === 0);
  await p.evaluate(() => window.harness.moveClock(292));   // 03:50, still day 16
  check('R2-3: at 03:50 the closed card offers the wake-up for the day ahead', await shows(p, '.closed-card') && await shows(p, ahead)
    && (await p.locator('[data-a="ahead"] > .eb').textContent()).includes('Up already?'));
  await tapIf(ahead);
  check('R2-3: tapped at 03:50 it is filed to the day ahead as 03:50, and counts as done', await until(() =>
    window.harness.dayValue(17, 'h-wake') === 230 && window.harness.dayValue(16, 'h-wake') === undefined)
    && await until(sel => document.querySelector(sel)?.getAttribute('data-s') === 'did'
      && document.querySelector(sel)?.querySelector('.val')?.textContent?.includes('03:50'), ahead)
    && (await p.locator('[data-a="save-note"]').count()) === 0);
  await p.evaluate(() => window.harness.moveClock(15));   // 04:05, day 17
  check('R2-3: after 04:00 the new morning shows the wake-up already in', await until(() => {
    const row = document.querySelector('.row[data-x="h-wake"]');
    return row?.getAttribute('data-s') === 'did' && row.querySelector('.val')?.textContent?.includes('03:50');
  }) && (await p.locator('[data-a="ahead"]').count()) === 0);

  const tonight = '.group:not([data-a="ahead"]) .row[data-x="h-wake"]';
  await h.open(p, 's=today&age=16&t=21:30');
  await shows(p, tonight);
  await p.evaluate(() => window.harness.moveClock(380));   // 03:50, still day 16, never closed
  check("R2-3: at 03:50 the evening offers the day ahead's wake-up above tonight's rows", await shows(p, ahead));
  await tapIf(tonight);
  await fillIf(`${tonight} [data-a="time-at"]`, '03:50');
  await tapIf(`${tonight} [data-a="time-save"]`);
  check("R2-3: 03:50 typed into tonight's empty wake-up goes to the day ahead, never the day before", await until(() =>
    window.harness.dayValue(17, 'h-wake') === 230 && window.harness.dayValue(16, 'h-wake') === undefined)
    && await until(sel => document.querySelector(sel)?.querySelector('.val')?.textContent?.includes('03:50'), ahead));

  // R2-9: "You can still change today until tomorrow night" is true: the next morning Today opens
  // yesterday in its own layout, a change there is saved to that day, and after the boundary that
  // ends today the way to it is gone
  const topline = () => p.locator('.today .topline .eb').first().textContent();
  await h.open(p, 's=today&age=1&t=21:30');
  await shows(p, '[data-a="close"]');
  check('R2-9: on day 1 there is no yesterday to offer', (await p.locator('[data-a="yesterday"]').count()) === 0);
  await h.open(p, 's=today&age=16&t=22:58&v=closed');
  await shows(p, '.closed-card');
  await p.evaluate(() => window.harness.moveClock(600));   // 08:58, day 17
  check('R2-9: the next morning Today offers yesterday by its date', await shows(p, '[data-a="yesterday"]')
    && (await p.locator('[data-a="yesterday"]').innerText()).includes('Tuesday 20 January'));
  await tapIf('[data-a="yesterday"]');
  check('R2-9: yesterday opens as its closed card, under a header naming the day', await shows(p, '.closed-card')
    && (await topline()).includes('Yesterday') && (await topline()).includes('Tuesday 20 January')
    && (await p.locator('[data-a="ahead"], [data-a="sheet"]').count()) === 0);
  await tapIf('[data-a="reopen"]');
  const reopened = await shows(p, '[data-a="close"]') && (await topline()).includes('Yesterday') && await shows(p, '.row[data-x="h-read"]');
  check('R2-9: "Open it again" opens yesterday\'s evening, still yesterday', reopened);
  if (reopened) {
    await p.tap('.row[data-x="h-read"]');
    await tapIf('.row[data-x="h-read"] .opt >> text=Did it');
  }
  check('R2-9: a change made there is saved to yesterday, not today', await until(() =>
    window.harness.dayValue(16, 'h-read') === 'did' && window.harness.dayValue(17, 'h-read') === undefined)
    && (await p.locator('[data-a="save-note"]').count()) === 0);
  await tapIf('.row[data-x="h-wake"], .chip[data-x="h-wake"]');
  check("R2-9: yesterday's wake-up asks for its time instead of taking this morning's clock", await shows(p, '.row[data-x="h-wake"] [data-a="time-at"]'));
  await tapIf('[data-a="close"]');
  check('R2-9: yesterday closes again, and stays yesterday', await shows(p, '.closed-card') && (await topline()).includes('Yesterday'));
  await tapIf('.today [data-a="nav"][data-x="today"]');
  check('R2-9: "Today" goes back to today', await until(() => !document.querySelector('.today .topline .eb')?.textContent?.includes('Yesterday'))
    && await shows(p, '[data-a="yesterday"]'));
  await tapIf('[data-a="yesterday"]');
  await shows(p, '.closed-card');
  await p.evaluate(() => window.harness.moveClock(19 * 60 + 7));   // 04:05, day 18
  check('R2-9: after the boundary that ends today, yesterday is gone: the screen is the new today, offering only the day just ended',
    await until(() => !document.querySelector('.today .topline .eb')?.textContent?.includes('Yesterday'))
    && await shows(p, '[data-a="yesterday"]') && !(await p.locator('[data-a="yesterday"]').innerText()).includes('20 January'));

    const q = await h.page(LAPTOP, errors);
  await h.open(q, 's=today&t=06:05');
  await shows(q, '.today .row');
  await q.keyboard.press('1');
  check('Today, laptop: key 1 marks the first row', await q.waitForFunction(() => document.querySelector('.row[data-x="h-wake"] .val')?.textContent?.includes('06:05'), null, { timeout: 8000 }).then(() => true, () => false));
  check('Today, laptop: the shape of today is there', await q.locator('.shape .sh').count() > 3);

  // R2-2: laptop keys reach the evening chips too: the rest day used, Walk's key records it done
  await h.open(q, 's=today&t=21:30');
  await shows(q, '[data-a="rest"][data-x="use"]');
  await q.click('[data-a="rest"][data-x="use"]');
  await q.waitForFunction(() => document.querySelectorAll('.earlier .chip').length === 3, null, { timeout: 8000 }).catch(() => {});
  const walkKey = await q.locator('.chip[data-x="h-walk"] .kbd').innerText({ timeout: 2000 }).catch(() => '');
  check('R2-2, laptop: an evening chip shows its key', /^[1-9]$/.test(walkKey));
  if (walkKey) await q.keyboard.press(walkKey);
  check('R2-2, laptop: the key marks a planned chip done', await q.waitForFunction(() => {
    const c = document.querySelector('.chip[data-x="h-walk"]');
    return c !== null && !c.classList.contains('idle') && !c.textContent?.includes('planned');
  }, null, { timeout: 8000 }).then(() => true, () => false));
  const wakeKey = await q.locator('.chip[data-x="h-wake"] .kbd').innerText({ timeout: 2000 }).catch(() => '');
  if (wakeKey) await q.keyboard.press(wakeKey);
  check('R2-2, laptop: the key on a planned wake-up asks for the time, ready to type', await shows(q, '.row[data-x="h-wake"] [data-a="time-at"]')
    && await q.evaluate(() => document.activeElement?.getAttribute('data-a') === 'time-at'));
}

// Look back
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=look&t=12:30');
  check('Look back: a card for each habit in Focus', await shows(p, '.hcard') && (await p.locator('.hcard').count()) === 3);
  check('Look back: the views still to come are named', (await p.locator('.later').first().innerText()).includes('Wake-time trend'));
  await p.tap('.hcard[data-x="h-walk"]');
  check("Look back: a card opens the habit's page", await shows(p, '.cal') && (await p.locator('h1.t-l').first().innerText()) === 'Walk');
  await p.tap('.scr [data-a="nav"][data-x="look"]');
  check('Look back: Back returns', await shows(p, '.hcard'));
  await h.open(p, 's=look&t=12:30&age=1');
  check('Look back, day 1: the record starts today', (await p.locator('.said-panel').first().innerText()).includes('The record starts today'));
  await h.open(p, 's=look&t=12:30&age=120');
  check('Look back, day 120: the months field and the trend are there', await shows(p, '.fld') && (await p.locator('svg.trend').count()) === 1);
  check('Look back: no score words, no internal flags', !/[!%]|is_backfill|edited_after_close|reopened_count/.test(await p.locator('#view').innerText()));

  const q = await h.page(LAPTOP, errors);
  await h.open(q, 's=look&t=12:30');
  await shows(q, '.evi .c');
  const before = await q.locator('.side .panel .eb').first().innerText();
  await q.locator('.evi .cells').first().locator('.c[data-a="sel"]').nth(2).click();
  check('Look back, laptop: clicking a column shows that day', (await q.locator('.side .panel .eb').first().innerText()) !== before
    && !(await q.locator('.side .panel .eb').first().innerText()).toUpperCase().startsWith('TODAY'));
  // the harness writes a page every fourth day (column 3 is day 4); the day panel counts it and never shows it
  let paged = false;
  for (const i of [15, 11, 7, 3]) {
    await q.locator(`.evi .cells >> nth=0 >> .c[data-x="${i}"]`).click();
    if (await q.locator('.side [data-x="diary"]').count()) { paged = true; break; }
  }
  check('Look back, laptop: a day with a diary page says so, without its words', paged
    && /^one entry · open$/.test(await q.locator('.side [data-x="diary"]').innerText()) && !(await q.locator('.side').innerText()).includes('CANARY'));
  await q.locator('.side [data-x="diary"]').click();
  check('Look back, laptop: the line opens the diary', await shows(q, '.diary'));

  // R3-10: no causal claim, and the wake-time trend named only when a time habit exists
  await h.open(p, 's=look&t=12:30');
  await shows(p, '.said-panel');
  check('R3-10: the views still to come never claim what helps', !(await p.locator('.later').first().innerText()).includes('What actually helps')
    && (await p.locator('.later').first().innerText()).includes('What seems to go well together'));
  await h.open(p, 's=look&t=12:30&v=notime');
  check('R3-10: with no time habit, the wake-time trend is not named as still to come',
    await shows(p, '.said-panel') && !(await p.locator('.later').first().innerText()).includes('Wake-time trend'));

  // R3-3: the run in progress is a headline only while it is 1 or more; at 0 it drops out, leaving
  // only the two numbers that never go down (§8 #1, #2)
  await h.open(p, 's=habit&v=h-walk&t=12:30&age=17');
  await shows(p, '.cal');
  check('R3-3: with a run in progress, the habit page shows three numbers, "this run" among them',
    (await p.locator('.phone-only .panel').first().locator('.meta').allInnerTexts()).includes('this run'));
  await h.open(p, 's=habit&v=h-walk&t=12:30&age=38');
  await shows(p, '.cal');
  check('R3-3: once a run has ended, "this run" is gone, and never shows a visible 0',
    !(await p.locator('.phone-only .panel').first().locator('.meta').allInnerTexts()).includes('this run')
    && (await p.locator('.phone-only .panel').first().locator('.num-xl').count()) === 2);

  // R3-8: the laptop day panel never spells out a miss ("not today"); a miss and an unanswered day
  // read as the identical faint dash (§8 R0, #7)
  await h.open(q, 's=look&t=12:30&age=38');
  await shows(q, '.evi .c');
  let dashCount = 0, sawMiss = false, colourOk = true;
  for (let i = 0; i < 28; i++) {
    const cell = q.locator('.evi .cells').first().locator(`.c[data-x="${i}"]`);
    if ((await cell.count()) === 0) continue;
    await cell.click();
    const dayRow = await q.evaluate(() => {
      const panel = document.querySelector('.side .panel');
      const vals = [...(panel?.querySelectorAll('.between') ?? [])].map(r => {
        const span = r.querySelectorAll('span')[1];
        return { text: span?.textContent ?? '', colour: span ? getComputedStyle(span).color : '' };
      });
      return { miss: vals.some(v => v.text === 'not today'), dashes: vals.filter(v => v.text === '—') };
    });
    if (dayRow.miss) sawMiss = true;
    if (dayRow.dashes.length > 0) {
      dashCount += dayRow.dashes.length;
      if (!dayRow.dashes.every(v => v.colour === dayRow.dashes[0].colour)) colourOk = false;
    }
  }
  check('R3-8: the day panel never says "not today"; every miss or unanswered day reads the same faint dash',
    !sawMiss && dashCount > 0 && colourOk);
}

// reviews
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=week&t=10:30');
  check('week: the week in words', await shows(p, '.wk-row') && (await p.locator('.band b').count()) > 0);
  await p.tap('[data-a="wstep"]');
  await p.fill('#wk-changed', 'CANARY week note');
  await p.tap('[data-a="wstep"]');
  check('week: the pager reaches the last card', (await p.locator('.dots i.on').count()) === 1 && (await p.locator('.phone-only [data-a="week-done"]').count()) === 1);
  await p.locator('.phone-only [data-a="week-done"]').tap();
  check("week: That's the week returns to Look back", await shows(p, '.hcard'));
  await h.open(p, 's=month&t=12:30&age=40');
  check('month: before day 60 it says when it opens', (await p.locator('h1.t-l').first().innerText()) === 'Opens on day 60');
  await h.open(p, 's=look&t=12:30&age=60');
  check('Look back offers the monthly review in its first week', await shows(p, '.panel.due'));
  await h.open(p, 's=month&t=12:30&age=60&v=steady');
  check('month: the month in words, and a steady habit offered to settle', await shows(p, '.mo-row') && await shows(p, '[data-a="settle"][data-x="yes"]'));
  await p.locator('.phone-only [data-a="settle"][data-x="yes"]').tap();
  check('month: settling says so', await p.waitForFunction(() => [...document.querySelectorAll('.panel .eb')].some(e => e.textContent === 'Settled'), null, { timeout: 8000 }).then(() => true, () => false));
  check('reviews: no numbers as scores, no exclamation', !/[!%]/.test(await p.locator('#view').innerText()));

  // R3-2: the close tapped straight from the line, so the line's blur and the close come in the same tap
  const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  await h.open(p, 's=month&t=12:30&age=60&v=steady');
  await shows(p, '.phone-only #mo-line');
  await p.tap('.phone-only #mo-line');
  await p.keyboard.type('CANARY-TEST a slow month');
  await p.tap('.phone-only [data-a="month-done"]');
  check("R3-2: That's the month, tapped from its line, keeps the line and closes the month", await shows(p, '.hcard')
    && await until(p, () => window.harness.reviews().some(r => r.key.startsWith('m:') && r.closed && r.answers.line === 'CANARY-TEST a slow month')));
  const w = await h.page(LAPTOP, errors);
  await h.open(w, 's=week&t=10:30');
  await shows(w, '.side #wk-changed');
  await w.click('.side #wk-changed');
  await w.keyboard.type('CANARY-TEST a new route');
  await w.click('.side #wk-line');
  await w.keyboard.type('CANARY-TEST an even week');
  await w.click('.side [data-a="week-done"]');
  check("R3-2: That's the week, clicked from its line on a laptop, keeps both answers and closes the week", await shows(w, '.hcard')
    && await until(w, () => window.harness.reviews().some(r => r.key.startsWith('w:') && r.closed
      && r.answers.changed === 'CANARY-TEST a new route' && r.answers.line === 'CANARY-TEST an even week')));

  // R3-4: on a Sunday, the week review covers Monday to that Sunday (C-4), not the week before
  await h.open(p, 's=week&t=10:30&age=14');
  await shows(p, '.wk-row');
  const sunText = await p.locator('#view').innerText();
  check('R3-4: a Sunday opens the week just lived, not the week before',
    sunText.toUpperCase().includes('SUNDAY 18 JANUARY') && sunText.includes('12 Jan – 18 Jan')
    && !sunText.toUpperCase().includes('11 JANUARY') && !sunText.includes('5 Jan'));
  await p.tap('[data-a="wstep"]');
  await p.fill('.phone-only #wk-line', 'CANARY-TEST a Sunday line');
  await p.tap('[data-a="wstep"]');
  await p.locator('.phone-only [data-a="week-done"]').tap();
  check("R3-4: That's the week files the answer under this week's own Monday, not last week's",
    await shows(p, '.hcard') && await until(p, () => window.harness.reviews().some(r => r.key === 'w:2026-01-12' && r.answers.line === 'CANARY-TEST a Sunday line')));

  // R3-7: Walk done every day it was asked, both weeks; the second week has two planned rest days
  // (so it was asked fewer days). The word compares rates, so this is never "dipped".
  await h.open(p, 's=week&t=10:30&age=17&v=rest');
  await shows(p, '.wk-row');
  const walkRow = await p.locator('.wk-row', { hasText: 'Walk' }).first().innerText();
  check('R3-7: a week of planned rest, done every day it was asked, is never "dipped"',
    walkRow.includes('most days') && !walkRow.includes('dipped'));

  // R3-9: the wake-up average rounds to a whole minute once, before it is split into hours and
  // minutes, so 06:59.6 reads as 07:00, never 06:00
  await h.open(p, 's=month&t=12:30&age=60&v=pairs');
  await shows(p, '.helps');
  const together = await p.locator('.helps').innerText();
  check('R3-9: a wake-up average that rounds up to the next hour carries the hour',
    together.includes('07:00') && together.includes('07:10') && !together.includes('06:00'));
}

// the diary and Not yet (invented words only)
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  await h.open(p, 's=diary&t=22:20');
  await shows(p, '.page');
  await p.tap('.page');
  await p.keyboard.type('CANARY-TEST a page for today');
  await p.tap('.diary .top .meta');
  await p.tap('[data-a="earlier"]');
  check('diary: leaving the page saves it into the index', await until(() => [...document.querySelectorAll('[data-a="earlier-list"] [data-a="page"]')].some(b => b.textContent?.includes('CANARY-TEST a page for today'))));
  await p.evaluate(() => window.harness.leave());
  await p.evaluate(() => window.harness.resume());
  await shows(p, '.lk-pass');
  await p.fill('input.pass', 'CANARY harness passphrase');
  await p.tap('[data-a="unlock"]');
  await shows(p, '.today', 15000);
  await p.tap('.dock button[data-x="diary"]');
  check('diary: the page is still there after a lock and an unlock', await until(() => document.querySelector('.page')?.textContent?.includes('CANARY-TEST a page for today')));
  await p.tap('[data-a="trash"]');
  const red = await p.locator('[data-a="trash-yes"]').evaluate(e => getComputedStyle(e).backgroundColor);
  check('diary: the trash confirm is the one red', await shows(p, '[data-a="trash-ask"]') && /oklch\(0\.56 0\.17 25|rgb\(2[0-9]{2}, [0-9]{2}, [0-9]{2}\)/.test(red));
  await p.tap('[data-a="trash-yes"]');
  check('diary: a trashed page waits in the trash, with the day its words go', await shows(p, '[data-a="earlier-list"] [data-a="trashed"]') && (await p.locator('[data-a="earlier-list"] [data-a="trashed"]').innerText()).includes('its words go on'));
  await p.tap('[data-a="earlier-list"] [data-a="putback"]');
  check('diary: Put back brings it back', await gone(p, '[data-a="earlier-list"] [data-a="trashed"]') && await until(() => [...document.querySelectorAll('[data-a="earlier-list"] [data-a="page"]')].some(b => b.textContent?.includes('CANARY-TEST'))));
  check('diary: nothing else on the screen is red', await p.evaluate(() => ![...document.querySelectorAll('#view *')].some(e => /rgb\(2[0-9]{2}, [0-6][0-9], [0-6][0-9]\)/.test(getComputedStyle(e).backgroundColor) || /rgb\(2[0-9]{2}, [0-6][0-9], [0-6][0-9]\)/.test(getComputedStyle(e).color))));

  await p.tap('.diary .top [data-a="nav"][data-x="notyet"]');
  await shows(p, '.ny');
  await p.tap('[data-a="ny-add"]');
  await p.fill('[data-a="ny-text"]', 'CANARY-TEST something later');
  await p.press('[data-a="ny-text"]', 'Enter');
  check('Not yet: writing something down keeps it', await until(() => [...document.querySelectorAll('[data-a="ny-item"]')].some(e => e.textContent?.includes('CANARY-TEST something later'))));
  await p.locator('[data-a="ny-away"]').first().tap();
  check('Not yet: putting it away keeps it for seven days', await shows(p, '[data-a="ny-trashed"]'));
  await p.tap('[data-a="ny-back"]');
  check('Not yet: bringing it back', await gone(p, '[data-a="ny-trashed"]'));
}

// R3-1 and R3-5: diary words, Not yet, the bad-night note and review lines are never lost to a
// trash, a new day or a refused save (invented words only)
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  const tryTap = sel => p.tap(sel, { timeout: 5000 }).then(() => true, () => false);
  const textOf = sel => p.evaluate(s => document.querySelector(s)?.textContent ?? '', sel);
  const valueOf = sel => p.evaluate(s => document.querySelector(s)?.value ?? '', sel);
  const pages = () => p.evaluate(() => window.harness.pages());
  const write = async text => { await p.tap('[data-a="page-text"]'); await p.keyboard.type(text); await p.tap('.diary .top .meta'); };

  // R3-1: today's page goes to the trash, and a new one is written in the same visit
  await h.open(p, 's=diary&t=22:20');
  await shows(p, '[data-a="page-text"]');
  await write('CANARY page one');
  await until(() => window.harness.pages().some(e => e.body === 'CANARY page one'));
  await p.tap('[data-a="trash"]');
  await p.tap('[data-a="trash-yes"]');
  await shows(p, '[data-a="earlier-list"] [data-a="trashed"]');
  await write('CANARY page two');
  check('R3-1: after a trash, a new page in the same visit is saved, with no "Not saved"',
    await until(() => window.harness.pages().some(e => e.body === 'CANARY page two' && !e.trashed)) && (await p.locator('.diary .panel.note').count()) === 0);
  check('R3-1: the trashed page keeps its own words', (await pages()).some(e => e.body === 'CANARY page one' && e.trashed));
  await p.tap('.dock button[data-x="today"]');
  await p.tap('.dock button[data-x="diary"]');
  check('R3-1: leaving the diary and coming back, the new page is there', await until(() => document.querySelector('[data-a="page-text"]')?.textContent === 'CANARY page two'));

  // R3-1: a visit open across the boundary never writes over the day before's page
  await h.open(p, 's=diary&t=03:30&age=18');
  await shows(p, '[data-a="page-text"]');
  await write('CANARY night page');
  await until(() => window.harness.pages().some(e => e.body === 'CANARY night page'));
  await p.evaluate(() => window.harness.moveClock(40));
  check('R3-1: at the new day the page starts empty', await until(() => document.querySelector('[data-a="page-text"]')?.textContent === ''));
  await write('CANARY morning page');
  check("R3-1: a page written after the boundary is the new day's; the night's page keeps its words", await until(() => {
    const all = window.harness.pages();
    const night = all.find(e => e.body === 'CANARY night page'), morning = all.find(e => e.body === 'CANARY morning page');
    return !!night && !!morning && night.date < morning.date;
  }));
  await h.open(p, 's=diary&t=03:30&age=18');
  await shows(p, '[data-a="page-text"]');
  await p.tap('[data-a="page-text"]');
  await p.keyboard.type('CANARY still writing');
  await p.evaluate(() => window.harness.moveClock(40));
  check('R3-1: words still being typed as the day moves on are saved to their page', await until(() => window.harness.pages().some(e => e.body === 'CANARY still writing')));

  // R3-5: a full phone; tonight's page, then another page opened from the index
  await h.open(p, 's=diary&t=22:20');
  await shows(p, '[data-a="page-text"]');
  await p.evaluate(() => window.harness.fullPhone(true));
  await p.tap('[data-a="page-text"]');
  await p.keyboard.type('CANARY tonight');
  await p.tap('[data-a="earlier"]');
  check('R3-5: a refused page says so while its words are on screen', await until(() => document.querySelector('.diary .panel.note')?.textContent?.includes('Not saved')));
  await p.locator('[data-a="earlier-list"] [data-a="page"]', { hasText: 'Yesterday' }).first().tap();
  check("R3-5: yesterday's page opens with no words about tonight's", await until(() => document.querySelector('[data-a="page-text"]')?.textContent === 'CANARY page for day 16')
    && (await p.locator('.diary .panel.note').count()) === 0);
  await tryTap('[data-a="earlier"]');
  check('R3-5: the index marks the page that is not saved yet', (await p.locator('[data-a="earlier-list"] .li', { hasText: 'not saved yet' }).count()) === 1);
  await p.locator('[data-a="earlier-list"] button.li', { hasText: 'Today' }).first().tap();
  check('R3-5: back on it, the refused page is in its field, with the not-saved words', await until(() => document.querySelector('[data-a="page-text"]')?.textContent === 'CANARY tonight')
    && (await textOf('.diary .panel.note')).includes('Not saved'));
  await p.evaluate(() => window.harness.fullPhone(false));
  await p.tap('[data-a="page-text"]');
  await p.tap('.diary .top .meta');
  check('R3-5: with space again, the next tap saves it and the words go', await until(() => window.harness.pages().some(e => e.body === 'CANARY tonight'))
    && await gone(p, '.diary .panel.note'));

  // R3-5: a refused page, then a dock tab; held words go at a lock (RF1)
  await h.open(p, 's=diary&t=22:20');
  await shows(p, '[data-a="page-text"]');
  await p.evaluate(() => window.harness.fullPhone(true));
  await p.tap('[data-a="page-text"]');
  await p.keyboard.type('CANARY dock page');
  await p.tap('.dock button[data-x="today"]');
  await shows(p, '.today');
  await p.tap('.dock button[data-x="diary"]');
  check('R3-5: a page refused as the dock was tapped comes back in its field, with the not-saved words', await until(() => document.querySelector('[data-a="page-text"]')?.textContent === 'CANARY dock page')
    && (await textOf('.diary .panel.note')).includes('Not saved'));
  await p.evaluate(() => window.harness.fullPhone(false));
  await p.evaluate(() => window.harness.leave());
  await p.evaluate(() => window.harness.resume());
  await shows(p, '.lk-pass');
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="unlock"]');
  await shows(p, '.today', 15000);
  await p.tap('.dock button[data-x="diary"]');
  await shows(p, '[data-a="page-text"]');
  check('R3-5: words held for a visit are gone after a lock (RF1)', (await textOf('[data-a="page-text"]')) === '' && (await p.locator('.diary .panel.note').count()) === 0
    && !(await pages()).some(e => e.body.includes('CANARY dock page')));

  // R3-5: Not yet, refused, then back to the diary
  await h.open(p, 's=notyet&t=22:30');
  await shows(p, '.ny');
  await p.tap('[data-a="ny-add"]');
  await p.fill('[data-a="ny-text"]', 'CANARY later');
  await p.evaluate(() => window.harness.fullPhone(true));
  await p.tap('.ny [data-a="nav"][data-x="diary"]');
  await shows(p, '.diary');
  await p.tap('.diary .top [data-a="nav"][data-x="notyet"]');
  check('R3-5: a Not yet item that was refused comes back in its field, with the not-saved words', await until(() => document.querySelector('[data-a="ny-text"]')?.value === 'CANARY later')
    && (await textOf('.ny .panel.note')).includes('Not saved'));
  await p.evaluate(() => window.harness.fullPhone(false));
  if (await p.locator('[data-a="ny-text"]').count()) await p.press('[data-a="ny-text"]', 'Enter');
  check('R3-5: with space again, Not yet keeps it and the words go', await until(() => [...document.querySelectorAll('[data-a="ny-item"]')].some(e => e.textContent?.includes('CANARY later')))
    && (await p.locator('.ny .panel.note').count()) === 0);

  // R3-5: a refusal that comes back after the screen was opened again still brings the words back
  await h.open(p, 's=notyet&t=22:30');
  await shows(p, '.ny');
  await p.tap('[data-a="ny-add"]');
  await p.fill('[data-a="ny-text"]', 'CANARY slow later');
  await p.evaluate(() => window.harness.fullPhone(true, 1500));
  await p.tap('.ny [data-a="nav"][data-x="diary"]');
  await shows(p, '.diary');
  await p.tap('.diary .top [data-a="nav"][data-x="notyet"]');
  await shows(p, '.ny');
  const before = await p.locator('[data-a="ny-text"]').count();
  check('R3-5: a Not yet refusal answered after the screen came back still brings the words back', before === 0
    && await until(() => document.querySelector('[data-a="ny-text"]')?.value === 'CANARY slow later'));
  await h.open(p, 's=month&t=12:30&age=60&v=steady');
  await shows(p, '.phone-only #mo-line');
  await p.fill('.phone-only #mo-line', 'CANARY slow month line');
  await p.evaluate(() => window.harness.fullPhone(true, 1500));
  await p.tap('.dock button[data-x="look"]');
  await p.tap('.panel.due');
  await shows(p, '.phone-only #mo-line');
  const empty = await valueOf('.phone-only #mo-line');
  check("R3-5: a month line refused after the screen came back still comes back in its field", empty === ''
    && await until(() => document.querySelector('.phone-only #mo-line')?.value === 'CANARY slow month line'));
  await p.evaluate(() => window.harness.fullPhone(false));

  // R3-5: the note for a bad night, refused, then back to Settings
  await h.open(p, 's=support&t=13:00');
  await shows(p, '[data-a="badnight"]');
  await p.evaluate(() => window.harness.fullPhone(true));
  await p.fill('[data-a="badnight"]', 'CANARY bad night');
  await p.tap('[data-a="support-back"]');
  await shows(p, '.settings');
  await p.tap('[data-a="support"]');
  check('R3-5: a refused note for a bad night comes back in its field, with the not-saved words', await until(() => document.querySelector('[data-a="badnight"]')?.value === 'CANARY bad night')
    && (await textOf('[data-a="badnight-problem"]')).includes('out of space'));
  await p.evaluate(() => window.harness.fullPhone(false));
  await p.focus('[data-a="badnight"]');
  await p.tap('h1');
  await gone(p, '[data-a="badnight-problem"]');
  await p.tap('[data-a="support-back"]');
  await p.tap('[data-a="support"]');
  check('R3-5: with space again, the note for a bad night is kept', await until(() => document.querySelector('[data-a="badnight"]')?.value === 'CANARY bad night')
    && (await p.locator('[data-a="badnight-problem"]').count()) === 0);

  // R3-5: the week's line, refused as Next takes it off screen
  await h.open(p, 's=week&t=10:30');
  await shows(p, '[data-a="wstep"]');
  await p.tap('[data-a="wstep"]');
  await p.fill('.phone-only #wk-line', 'CANARY week line');
  await p.evaluate(() => window.harness.fullPhone(true));
  await p.tap('[data-a="wstep"]');
  await p.waitForTimeout(300);
  check('R3-5: on the next card, nothing says the line is still here', !(await p.locator('#view').innerText()).includes('still here'));
  await p.tap('.dock button[data-x="look"]');
  await p.tap('[data-a="nav"][data-x="week"]');
  await p.tap('[data-a="wstep"]');
  check("R3-5: back on the week's questions, the refused line is in its field, with the not-saved words", await until(() => document.querySelector('.phone-only #wk-line')?.value === 'CANARY week line')
    && (await textOf('.phone-only [data-a="held-note"]')).includes('Not saved'));
  await p.evaluate(() => window.harness.fullPhone(false));
  await p.tap('[data-a="wstep"]');
  await tryTap('.phone-only [data-a="week-done"]');
  await shows(p, '.hcard');
  await tryTap('[data-a="nav"][data-x="week"]');
  await tryTap('[data-a="wstep"]');
  check("R3-5: That's the week takes the held line with it", await until(() => document.querySelector('.phone-only #wk-line')?.value === 'CANARY week line')
    && (await p.locator('.phone-only [data-a="held-note"]').count()) === 0);

  // R3-5: the month's line, refused as a dock tab leaves it
  await h.open(p, 's=month&t=12:30&age=60&v=steady');
  await shows(p, '.phone-only #mo-line');
  await p.fill('.phone-only #mo-line', 'CANARY month line');
  await p.evaluate(() => window.harness.fullPhone(true));
  await p.tap('.dock button[data-x="look"]');
  await p.tap('.panel.due');
  check("R3-5: back on the month, the refused line is in its field, with the not-saved words", await until(() => document.querySelector('.phone-only #mo-line')?.value === 'CANARY month line')
    && (await textOf('.phone-only [data-a="held-note"]')).includes('Not saved'));
  await p.evaluate(() => window.harness.fullPhone(false));
}

// R3-6: the app is left while a field still has focus (the screen going off mid-sentence, before
// any blur): what is in the field is saved before the lock, and is there after an unlock (invented words only)
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  const leaveAndUnlock = async () => {
    await p.evaluate(() => window.harness.leave());
    const blank = await gone(p, '.scr', 3000);
    await p.evaluate(() => window.harness.resume());
    await shows(p, '.lk-pass');
    await p.fill('input.pass', PASSPHRASE);
    await p.tap('[data-a="unlock"]');
    return blank && await shows(p, '.today', 15000);
  };

  await h.open(p, 's=diary&t=22:20');
  await shows(p, '[data-a="page-text"]');
  await p.tap('[data-a="page-text"]');
  await p.keyboard.type('CANARY mid-sentence when the screen went off');
  const focused = await p.evaluate(() => document.activeElement?.matches('[data-a="page-text"]') === true);
  const back = await leaveAndUnlock();
  check('R3-6: a leave with the diary page in focus still blanks the screen at once (RF1)', focused && back);
  check('R3-6: ... and the page is saved before the lock, there after an unlock', await until(() => window.harness.pages().some(e => e.body === 'CANARY mid-sentence when the screen went off')));
  await p.tap('.dock button[data-x="diary"]');
  check('R3-6: ... and it is on the diary page', await until(() => document.querySelector('[data-a="page-text"]')?.textContent === 'CANARY mid-sentence when the screen went off'));

  await h.open(p, 's=notyet&t=22:30');
  await shows(p, '.ny');
  await p.tap('[data-a="ny-add"]');
  await shows(p, '[data-a="ny-text"]');
  await p.keyboard.type('CANARY a thought still in the field');
  await leaveAndUnlock();
  await p.tap('.dock button[data-x="diary"]');
  await p.tap('.diary .top [data-a="nav"][data-x="notyet"]');
  check('R3-6: a Not yet item still in its field at a leave is kept', await until(() => [...document.querySelectorAll('[data-a="ny-item"]')].some(e => e.textContent?.includes('CANARY a thought still in the field'))));

  await h.open(p, 's=today&t=21:30');
  await shows(p, '#remark');
  await p.tap('#remark');
  await p.keyboard.type('CANARY-TEST an evening line');
  await leaveAndUnlock();
  check("R3-6: Today's evening words still in their field at a leave are saved to the day", await until(() => window.harness.dayWords(17).remark === 'CANARY-TEST an evening line'));
}

// Plan
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  await h.open(p, 's=plan&t=13:00');
  check('Plan: three Focus slots and Log', await shows(p, '.slots') && (await p.locator('.slot').count()) === 3 && (await p.locator('.pl-log').count()) > 3);
  const gear = await p.locator('#view [data-a="nav"][data-x="settings"]').boundingBox();
  check('Plan: the gear is a full thumb target, 44 by 44', gear !== null && gear.width >= 44 && gear.height >= 44);
  await p.tap('#view [data-a="nav"][data-x="settings"]');
  check('Plan: on a phone the gear opens Settings, with Plan still lit', await shows(p, '.settings') && (await p.locator('#dock .on').innerText()) === 'Plan');
  await h.open(p, 's=plan&t=13:00');
  await p.tap('.slot[data-x="h-wake"]');
  check('Plan: a row opens the edit sheet on a phone', await shows(p, '.sheet[role="dialog"] [data-a="editor"]') && (await p.locator('.sheet h2').innerText()) === 'Wake up');
  check("Plan: an existing habit's kind can't be changed", await p.locator('.sheet .seg button:not(.on)').first().isDisabled());
  await p.fill('.sheet input[type="time"][aria-label="Reminder time"]', '06:45');
  await p.tap('.sheet [data-a="cue-add"]');
  check('Plan: a reminder is added, with its words', await until(() => document.querySelector('.sheet [data-a="cue"] .sub')?.textContent?.includes('Wake up')));
  await p.tap('.sheet [data-a="keep"]');
  check('Plan: keep private hides the reminder words', await until(() => document.querySelector('.sheet [data-a="cue"] .sub')?.textContent?.includes('shows only "Daily Commit"')));
  await p.tap('.sheet [data-a="plan-x"]');
  await p.tap('[data-a="add"]');
  await p.fill('.sheet #h-name', 'CANARY-TEST stretch again');
  await p.tap('.sheet [data-a="plan-save"]');
  check('Plan: a new habit joins Log', await until(() => [...document.querySelectorAll('.pl-log .nm')].some(e => e.textContent === 'CANARY-TEST stretch again')));
  await p.tap('[data-a="add"]');
  await p.tap('.sheet [data-a="plan-save"]');
  check('Plan: a form with no name says so', await shows(p, '[data-a="form-problems"]') && (await p.locator('[data-a="form-problems"]').innerText()).includes('needs a name'));
  await p.tap('.sheet [data-a="plan-x"]');
  await p.tap('.dock button[data-x="today"]');
  check('Plan: the new habit is asked in Today', await until(() => [...document.querySelectorAll('.row .nm')].some(e => e.textContent === 'CANARY-TEST stretch again')) || (await p.locator('.today').count()) === 1);
  const q = await h.page(LAPTOP, errors);
  await h.open(q, 's=plan&t=13:00');
  await shows(q, '[data-a="editor"]');
  await q.click('.slot[data-x="h-walk"]');
  check('Plan, laptop: selecting switches the editor', await q.waitForFunction(() => document.querySelector('main [data-a="editor"] h2')?.textContent === 'Walk', null, { timeout: 8000 }).then(() => true, () => false));

  // R2-6: Focus/Log buttons save at once, and the editor shows the change instead of looking stuck
  await h.open(p, 's=plan&t=13:00');
  await p.tap('.slot[data-x="h-walk"]');
  await shows(p, '.sheet [data-a="editor"]');
  await p.tap('.sheet [data-a="tier"][data-x="log"]');
  check('R2-6: tapping Log in the editor moves the segment at once', await until(() =>
    document.querySelector('.sheet [data-a="tier"][data-x="log"]')?.classList.contains('on')
    && !document.querySelector('.sheet [data-a="tier"][data-x="focus"]')?.classList.contains('on')));
  check('R2-6: the words under it follow, too', (await p.locator('.sheet .fgrp:has-text("Tier") .meta').innerText()) === 'Log is kept and never scored.');
  await p.tap('.sheet [data-a="plan-x"]');
  check("R2-6: Cancel never pretended to undo a save that already happened — Walk left Focus for good",
    (await p.locator('.slot[data-x="h-walk"]').count()) === 0 && (await p.locator('.pl-log .nm').allInnerTexts()).includes('Walk'));

  // R2-11: on a laptop, Cancel discards edits in the editor shown by default (nothing explicitly chosen)
  await h.open(q, 's=plan&t=13:00');
  await shows(q, '[data-a="editor"]');
  check('R2-11: the default editor is the first Focus habit', (await q.inputValue('#h-name')) === 'Wake up');
  await q.fill('#h-name', 'CANARY-TEST changed name');
  await q.click('main [data-a="plan-x"]');
  check('R2-11: Cancel discards the typed name', await q.waitForFunction(
    () => document.querySelector('#h-name')?.value === 'Wake up', null, { timeout: 8000 }).then(() => true, () => false));

  // R2-12: "Bring back" with Focus full says why, instead of a dead-end refusal
  await h.open(p, 's=plan&v=retired&t=13:00');
  await shows(p, '.slots');
  check('R2-12: Read moved into the slot Walk left', (await p.locator('.slot .nm').allInnerTexts()).includes('Read'));
  check('R2-12: Walk sits in Retired', await shows(p, '[data-a="edit"][data-x="h-walk"]')
    && (await p.locator('.group:has-text("Retired") .nm').innerText()) === 'Walk');
  await p.tap('[data-a="edit"][data-x="h-walk"]');
  await shows(p, '.sheet [data-a="editor"]');
  await p.tap('[data-a="return"]');
  check("R2-12: Bring back with Focus full says why, not 'Something in it can't be saved'",
    await until(() => document.querySelector('.sheet .panel.note .eb')?.textContent === 'Back in Log')
    && (await p.locator('.sheet .panel.note .body').innerText()).includes('Focus is full'));
  check('R2-12: it really did go to Log — the segment shows it', (await p.locator('.sheet [data-a="tier"][data-x="log"].on').count()) === 1);

  // R2-8: a write that throws something other than a full phone still says Save didn't go through
  await h.open(p, 's=plan&t=13:00');
  await p.tap('.slot[data-x="h-wake"]');
  await shows(p, '.sheet [data-a="editor"]');
  await p.evaluate(() => window.harness.failWrite());
  await p.tap('.sheet [data-a="plan-save"]');
  check('R2-8 (Plan): a thrown write still gets the not-saved words', await until(() =>
    document.querySelector('.sheet .panel.note .eb')?.textContent?.toLowerCase().includes('not saved')));

  // R2-4: a count habit is added with a bar, drawn on Today as a plain number, and edited with -1 / +1
  const COUNT_NAME = 'CANARY-TEST glasses of water';
  /** the row's drawn value, found by the habit's name (its id is picked only when the editor opens) */
  const countValIs = expect => until(a => {
    const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.nm')?.textContent === a.name);
    const val = row?.querySelector('.val')?.cloneNode(true);
    val?.querySelector('.kbd')?.remove();
    return val?.textContent?.trim() === a.expect;
  }, { name: COUNT_NAME, expect });
  await h.open(p, 's=plan&t=13:00');
  await p.tap('[data-a="add"]');
  await p.fill('.sheet #h-name', COUNT_NAME);
  await p.tap('.sheet [data-a="kind"][data-x="count"]');
  check('R2-4: Plan offers a bar field for a count, like minutes', await shows(p, '.sheet #h-bar'));
  await p.fill('.sheet #h-bar', '3');
  await p.tap('.sheet [data-a="plan-save"]');
  check('R2-4: the count habit is saved into Log', await until(() => [...document.querySelectorAll('.pl-log .nm')].some(e => e.textContent === 'CANARY-TEST glasses of water')));
  await p.tap('.dock button[data-x="today"]');
  await p.evaluate(() => window.harness.moveClock(70));   // past 14:00, so the evening-asked row is drawn
  await shows(p, '.today');
  const countRow = `.row:has-text("${COUNT_NAME}")`;
  check('R2-4: an unlogged count reads "—", not "— min"', await countValIs('—'));
  await p.tap(countRow);
  await p.tap(`${countRow} [data-a="addcount"][data-x$=":1"]`);
  check('R2-4: +1 on a count reads as the number 1, not "15m"', await countValIs('1'));
  await p.tap(`${countRow} [data-a="addcount"][data-x$=":1"]`);
  await p.tap(`${countRow} [data-a="addcount"][data-x$=":-1"]`);
  check('R2-4: -1 brings it back down, one at a time', await countValIs('1'));

  // R2-5: a time asked at night, done by 00:30, is met by 22:30 and by 00:15; a stored partly has its field
  const BED_NAME = 'CANARY-TEST in bed';
  const bedRow = `.row:has-text("${BED_NAME}")`;
  const bedIs = (state, time) => until(a => {
    const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.nm')?.textContent === a.name);
    return row?.getAttribute('data-s') === a.state && (row.querySelector('.val')?.textContent ?? '').includes(a.time);
  }, { name: BED_NAME, state, time });
  await h.open(p, 's=plan&t=13:00');
  await p.tap('[data-a="add"]');
  await p.fill('.sheet #h-name', BED_NAME);
  await p.tap('.sheet [data-a="kind"][data-x="time"]');
  await p.tap('.sheet .seg button:has-text("At night")');
  await p.fill('.sheet #h-band', '00:30');
  await p.tap('.sheet [data-a="plan-save"]');
  check('R2-5: a night habit done by 00:30 is saved into Log', await until(n => [...document.querySelectorAll('.pl-log .nm')].some(e => e.textContent === n), BED_NAME));
  await p.locator('.pl-log', { hasText: BED_NAME }).tap();
  check('R2-5: the editor shows the band back as 00:30', await shows(p, '.sheet [data-a="editor"]') && (await p.inputValue('.sheet #h-band')) === '00:30');
  await p.tap('.sheet [data-a="plan-x"]');
  await p.tap('.dock button[data-x="today"]');
  await p.evaluate(() => window.harness.moveClock(570));   // 22:30
  await shows(p, bedRow);
  await p.tap(bedRow);
  check('R2-5: logged at 22:30, it counts as done by 00:30', await bedIs('did', '22:30'));
  await p.evaluate(() => window.harness.moveClock(105));   // 00:15, still the same night
  await p.tap(bedRow);
  await p.tap(`${bedRow} [data-a="setnow"]`);
  check('R2-5: logged at 00:15, it counts as done by 00:30', await bedIs('did', '00:15'));
  await h.open(p, 's=plan&t=13:00');
  await p.tap('.slot[data-x="h-wake"]');
  check("R2-5: a stored partly shows in the editor's own field", await shows(p, '.sheet #h-part') && (await p.inputValue('.sheet #h-part')) === '07:30');
  await p.fill('.sheet #h-band', '07:45');
  await p.tap('.sheet [data-a="plan-save"]');
  check('R2-5: a done later than partly is refused in words about the partly field the screen shows',
    await shows(p, '[data-a="form-problems"]') && (await p.locator('[data-a="form-problems"]').innerText()).includes('time for partly'));
  if (await p.locator('.sheet #h-part').count()) await p.fill('.sheet #h-part', '');
  await p.tap('.sheet [data-a="plan-save"]');
  check('R2-5: emptying partly lets it save', await gone(p, '.sheet [data-a="editor"]'));

  // R2-10: a weekday change saved after today is already logged starts tomorrow (B-3); the line and
  // a reopened editor now show the new days and say so, instead of the old days with nothing said
  await h.open(p, 's=today&t=21:30');
  await shows(p, '.row[data-x="h-walk"]');
  await p.tap('.row[data-x="h-walk"]');
  await p.tap('.row[data-x="h-walk"] .opt >> text=Did it');
  // a Focus habit answered in the evening leaves its row for a chip (R2-2); its value is still saved
  check('R2-10: Walk is logged for today', await until(() =>
    [...document.querySelectorAll('.earlier .chip')].some(c => c.textContent?.includes('walk') && !c.classList.contains('idle'))));
  await p.tap('.dock button[data-x="plan"]');
  await shows(p, '.slots');
  await p.tap('.slot[data-x="h-walk"]');
  await shows(p, '.sheet [data-a="editor"]');
  check('R2-10: before any change, nothing says "from tomorrow"', (await p.locator('[data-a="from-tomorrow"]').count()) === 0);
  await p.tap('.sheet .days button >> nth=5');   // turn off Saturday
  await p.tap('.sheet .days button >> nth=6');   // turn off Sunday
  await p.tap('.sheet [data-a="plan-save"]');
  check('R2-10: the line under Walk shows the new days and says from tomorrow, not the old "every day"', await until(() => {
    const sub = document.querySelector('.slot[data-x="h-walk"] .sub')?.textContent ?? '';
    return sub.includes('Mon–Fri') && sub.includes('from tomorrow');
  }));
  await p.tap('.slot[data-x="h-walk"]');
  await shows(p, '.sheet [data-a="editor"]');
  check('R2-10: the reopened editor shows the new days, not the old seven', (await p.locator('.sheet .days button.on').count()) === 5);
  check('R2-10: the editor says the change starts tomorrow', await shows(p, '.sheet [data-a="from-tomorrow"]')
    && (await p.locator('.sheet [data-a="from-tomorrow"]').innerText()).includes('starts tomorrow'));
  await p.tap('.sheet [data-a="plan-x"]');
}

// Settings
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  await h.open(p, 's=settings&t=13:00');
  check('Settings: every group shows on a phone', await shows(p, '.settings') && (await p.locator('.set-grp').count()) === 7);
  const text = await p.locator('.settings').innerText();
  check('Settings: no stale lines', !['Clock app', '60 seconds', 'export once a week'].some(w => text.includes(w)) && !/[!%]/.test(text));
  await p.locator('[data-a="contrast"]').fill('70');
  check('Settings: the contrast slider sets --k', await until(() => document.documentElement.style.getPropertyValue('--k') === '0.7'));
  await p.tap('[data-a="pause"]');
  check('Settings: pause tracking switches on', await until(() => document.querySelector('[data-a="pause"] .toggle')?.classList.contains('on')));
  await p.tap('[data-a="pause"]');
  check('Settings: and off again', await until(() => !document.querySelector('[data-a="pause"] .toggle')?.classList.contains('on')));
  await p.tap('[data-a="export"]');
  check('Settings: Export hands a locked copy to the save picker', await until(() => /^backup-\d{4}-\d{2}-\d{2}\.dcbak$/.test(document.documentElement.dataset.saved ?? ''))
    && (await p.locator('[data-a="exported"]').innerText()) === 'Saved where you chose.');
  check('Settings: the space used reads in MB', text.includes('On this phone · 2.4 MB'));
  await p.tap('[data-a="support"]');
  check('Settings: Support is reachable', await until(() => document.querySelector('h1')?.textContent === 'Support'));
  await h.open(p, 's=settings&t=13:00');
  await shows(p, '.settings');
  await p.tap('[data-a="done"]');
  check('Settings: Done goes to Plan', await shows(p, '.slots'));
  const q = await h.page(LAPTOP, errors);
  await h.open(q, 's=settings&t=13:00');
  await shows(q, '.settings');
  check('Settings, laptop: Display is open first', (await q.locator('main[data-cat="display"]').count()) === 1);
  await q.click('[data-a="setcat"][data-x="about"]');
  check('Settings, laptop: a category switches the panel', await shows(q, 'main[data-cat="about"]') && (await q.locator('main[data-cat="about"]').textContent()).includes("What the lock can't do"));
}

// Privacy and the keys to the record
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 15000 }).then(() => true, () => false);
  await h.open(p, 's=settings&v=privacy&t=13:00');
  check("Privacy: the phone's lock is how it opens", await shows(p, '[data-a="unlockmode"][data-x="phone"].on'));
  await p.tap('[data-a="unlockmode"][data-x="own"]');
  check('Privacy: a separate code asks for the passphrase first', await shows(p, '[data-a="auth"]'));
  await p.fill('input.pass', 'CANARY not the passphrase');
  await p.tap('[data-a="auth"]');
  check('Privacy: a wrong passphrase says so', await shows(p, '[data-a="secret-note"]', 15000));
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="auth"]');
  await shows(p, '.pad', 15000);
  // C9: the code lives in a ref; no component's state holds a string of digits
  const digitsInState = () => p.evaluate(() => {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer$'));
    const stack = key ? [root[key]] : [];
    while (stack.length) {
      const f = stack.pop();
      for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        if (typeof h.memoizedState === 'string' && /^[0-9]{2,}$/.test(h.memoizedState)) return true;
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return false;
  });
  await typeCode(p, CODE);
  check('Privacy: own code, the chosen digits are in no component state', !(await digitsInState()));
  await p.tap('[data-a="pinok"]');
  check('Privacy: own code, step 2 asks for it again', await until(() => document.querySelector('h1')?.textContent === 'Type it again'));
  await typeCode(p, '13572468');
  check('Privacy: own code, neither entry is in component state', !(await digitsInState()));
  await p.tap('[data-a="pinok"]');
  check('Privacy: two different codes start again', await until(() => document.querySelector('h1')?.textContent === 'Choose a code') && await shows(p, '[data-a="secret-note"]'));
  await typeCode(p, CODE);
  await p.tap('[data-a="pinok"]');
  await until(() => document.querySelector('h1')?.textContent === 'Type it again');
  await typeCode(p, CODE);
  await p.tap('[data-a="pinok"]');
  check('Privacy: own code is set, through the real enrolment', await until(() => document.querySelector('[data-a="secret-done"]')?.textContent === 'Your code is set'));
  await p.tap('[data-a="done"]');
  check('Privacy: back in Settings the separate code is chosen, with the fingerprint switch', await shows(p, '[data-a="unlockmode"][data-x="own"].on') && await shows(p, '[data-a="biotoggle"]'));

  // a key store that refuses: the screen says so and is usable again, rather than waiting for good
  const notSet = () => until(() => document.querySelector('[data-a="secret-note"]')?.textContent?.startsWith('Not set'));
  await h.open(p, 's=secret&v=owncode&t=13:00');
  await shows(p, '[data-a="auth"]');
  await p.evaluate(() => window.harness.refuseEnrol());
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="auth"]');
  await shows(p, '.pad', 15000);
  await typeCode(p, CODE);
  await p.tap('[data-a="pinok"]');
  await until(() => document.querySelector('h1')?.textContent === 'Type it again');
  await typeCode(p, CODE);
  await p.tap('[data-a="pinok"]');
  check('Privacy: own code refused by the key store says Not set, and the pad works again', await notSet() && await until(() => document.querySelector('h1')?.textContent === 'Choose a code') && !(await p.locator('.pad').innerText()).includes('Opening'));
  await h.open(p, 's=secret&v=phone&t=13:00');
  await shows(p, '[data-a="auth"]');
  await p.evaluate(() => window.harness.refuseEnrol());
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="auth"]');
  check("Privacy: the phone's lock refused by the key store says Not set, and Continue works again", await notSet() && await until(() => {
    const b = document.querySelector('[data-a="auth"]');
    return b?.textContent === 'Continue' && !b.disabled;
  }));

  // a way of opening the phone can't confirm: Settings says what wasn't set and what opens it now, path by path
  const unconfirmed = async (hash, setUp, path, words) => {
    try {
      await h.open(p, hash);
      await shows(p, '[data-a="auth"]');
      await p.evaluate(setUp);
      await p.fill('input.pass', PASSPHRASE);
      await p.tap('[data-a="auth"]');
      if (path === 'new-code' || path === 'code-change') {
        await shows(p, '.pad', 15000);
        for (const step of ['Type it again', '']) {
          await typeCode(p, CODE);
          await p.tap('[data-a="pinok"]');
          if (step) await until(t => document.querySelector('h1')?.textContent === t, step);
        }
      }
      return await until(([x, w]) => {
        const n = document.querySelector('[data-a="notverified"]');
        return n?.getAttribute('data-x') === x && w.every(t => n.textContent.includes(t));
      }, [path, words]);
    } catch {
      return false;
    }
  };
  const on = x => p.locator(`[data-a="unlockmode"][data-x="${x}"].on`).count().then(n => n === 1);
  check("Privacy: a first code the phone couldn't confirm says so, and that the phone's lock still opens it",
    await unconfirmed('s=secret&v=owncode&t=13:00', () => window.harness.failCheck(), 'new-code', ["The code wasn't set", "Your phone's lock and your passphrase still open Daily Commit"]) && await on('phone'));
  check("Privacy: a changed code the phone couldn't confirm says the code is off and only the passphrase opens it",
    await unconfirmed('s=secret&v=changecode&t=13:00', async () => { await window.harness.ownCode(); window.harness.failCheck(); }, 'code-change',
      ['The separate code is off', 'The old code had already been replaced', 'For now only your passphrase opens Daily Commit']) && !(await on('own')) && !(await on('phone')));
  check("Privacy: the phone's lock prompt backed out of, from own-code mode, says the code still opens it",
    await unconfirmed('s=secret&v=phone&t=13:00', async () => { await window.harness.ownCode(); window.harness.cancelPrompt(); }, 'phone-lock',
      ["The phone's lock wasn't set up", 'Your code, the fingerprint and your passphrase still open Daily Commit']) && await on('own') && !(await on('phone')));
  check('Privacy: the fingerprint prompt backed out of says the fingerprint is still off and the code still opens it',
    await unconfirmed('s=secret&v=finger&t=13:00', async () => { await window.harness.ownCode(); window.harness.cancelPrompt(); }, 'fingerprint',
      ['Fingerprint is still off', 'Your code and your passphrase still open Daily Commit']) && await on('own')
      && !(await p.locator('[data-a="biotoggle"] .toggle.on').count()));

  await h.open(p, 's=secret&v=pass&t=13:00');
  await shows(p, '[data-a="pass-change"]');
  await p.fill('input[aria-label="Current passphrase"]', PASSPHRASE);
  await p.fill('input[aria-label="New passphrase"]', 'too short');
  await p.tap('[data-a="pass-change"]');
  check('Change passphrase: under 15 characters is refused', await until(() => document.querySelector('[data-a="secret-note"]')?.textContent?.includes('at least 15 characters')));
  await p.fill('input[aria-label="Current passphrase"]', PASSPHRASE);
  await p.fill('input[aria-label="New passphrase"]', 'CANARY river stone lamp cloud');
  await p.tap('[data-a="pass-change"]');
  check('Change passphrase: Changed', await until(() => document.querySelector('[data-a="secret-done"]')?.textContent === 'Changed'));

  await h.open(p, 's=secret&v=pass&t=13:00');
  await shows(p, '[data-a="pass-change"]');
  await p.tap('[data-a="pass-usecode"]');
  const resetCode = await p.evaluate(() => window.harness.recoveryCode);
  await p.fill('input[aria-label="Recovery code"]', resetCode);
  await p.fill('input[aria-label="New passphrase"]', 'CANARY a forgotten one replaced');
  await p.tap('[data-a="pass-change"]');
  check('Change passphrase: the recovery code stands in for a forgotten one', await until(() => document.querySelector('[data-a="secret-done"]')?.textContent === 'Changed'));
  await p.evaluate(() => window.harness.leave());
  await p.evaluate(() => window.harness.resume());
  if (await shows(p, '[data-a="lockpass"]', 3000)) await p.tap('[data-a="lockpass"]');
  await shows(p, '.lk-pass');
  await p.fill('input.pass', 'CANARY a forgotten one replaced');
  await p.tap('[data-a="unlock"]');
  check('Change passphrase: the new passphrase then opens the record', await shows(p, '.today', 15000));

  await h.open(p, 's=secret&v=newcode&t=13:00');
  await shows(p, '[data-a="auth"]');
  await p.fill('input.pass', PASSPHRASE);
  await p.tap('[data-a="auth"]');
  check('New recovery code: shown after the passphrase', await shows(p, '[data-a="code"]', 15000));
  const code = await p.locator('[data-a="code"] span').allTextContents();
  await p.tap('[data-a="written"]');
  await p.fill('input.typeback-in', 'ABCDE');
  await p.tap('[data-a="finish"]');
  check('New recovery code: a wrong type-back keeps the old one', await shows(p, '[data-a="secret-note"]'));
  await p.fill('input.typeback-in', code.join(' '));
  await p.tap('[data-a="finish"]');
  check('New recovery code: typed back, it is in use', await until(() => document.querySelector('[data-a="secret-done"]')?.textContent === 'The new code is in use'));

  await h.open(p, 's=secret&v=check&t=13:00');
  await shows(p, '[data-a="check"]');
  await p.fill('input.typeback-in', 'ABCDE ABCDE');
  await p.tap('[data-a="check"]');
  check("Check the code: a wrong one says it doesn't match", await shows(p, '[data-a="secret-note"]', 15000));

  await h.open(p, 's=settings&v=notverified-new-code&t=13:00');
  check("Privacy: a code the phone could not confirm shows \"The code wasn't set\"", await shows(p, '[data-a="notverified"][data-x="new-code"]'));
  check('Privacy: no loud lines', !/[!%]/.test(await p.locator('.settings').innerText()));
}

// Support and pause
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  await h.open(p, 's=support&t=13:00');
  check('Support: the helpline is there, and nothing is loud', await shows(p, '.phone-n') && !/[!%]/.test(await p.locator('main').innerText()));
  await p.tap('[data-a="contact-edit"]');
  await p.fill('input[aria-label="A name and number"]', 'CANARY-TEST 000');
  await p.tap('[data-a="contact-save"]');
  check('Support: someone you trust is kept', await until(() => document.querySelector('[data-a="contact"]')?.textContent === 'CANARY-TEST 000'));
  await p.fill('[data-a="badnight"]', 'CANARY-TEST note');
  await p.tap('h1');
  await p.tap('[data-a="support-back"]');
  await shows(p, '.settings');
  await p.tap('[data-a="support"]');
  check('Support: the note for a bad night is kept', await until(() => document.querySelector('[data-a="badnight"]')?.value === 'CANARY-TEST note'));

  await h.open(p, 's=settings&t=13:00');
  await shows(p, '.settings');
  await p.tap('[data-a="pause"]');
  await until(() => document.querySelector('[data-a="pause"] .toggle')?.classList.contains('on'));
  await p.tap('.dock button[data-x="today"]');
  check('Pause: Today shows "Tracking is paused" in place of the habits', await shows(p, '[data-a="paused"]') && (await p.locator('.row').count()) === 0);
  await p.tap('.dock button[data-x="look"]');
  check('Pause: so does Look back', await shows(p, '[data-a="paused"]'));
  await p.tap('.dock button[data-x="diary"]');
  check('Pause: the diary is unchanged', await gone(p, '[data-a="paused"]') && await shows(p, '.diary .page'));
  await p.tap('.dock button[data-x="today"]');
  await p.tap('[data-a="paused-settings"]');
  await shows(p, '[data-a="pause"]');
  await p.tap('[data-a="pause"]');
  await until(() => !document.querySelector('[data-a="pause"] .toggle')?.classList.contains('on'));
  await p.tap('.dock button[data-x="today"]');
  check('Pause: off again, Today asks as before', await shows(p, '.today') && (await p.locator('[data-a="paused"]').count()) === 0);
}

// the diary's writing mode: the bars step back while the page has focus
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=diary&t=22:20');
  await shows(p, '[data-a="page-text"]');
  await p.focus('[data-a="page-text"]');
  check('diary: writing on the page dims the bars', await shows(p, '.app.is-writing'));
  await p.locator('[data-a="page-text"]').evaluate(e => e.blur());
  check('diary: leaving the page brings them back', await gone(p, '.app.is-writing'));
}

// invariant 4: the morning holds nothing logged on an earlier day (§8)
{
  const marks = ['1h 25m', '06:55', 'CANARY-TEST yesterday'];
  const drawn = p => p.evaluate(() => {
    const view = document.getElementById('view');
    return `${view?.innerText ?? ''}\n${[...(view?.querySelectorAll('textarea, input') ?? [])].map(e => e.value).join('\n')}`;
  });
  for (const size of [PHONE, LAPTOP]) {
    const p = await h.page(size, errors);
    await h.open(p, 's=today&t=06:30&canary=1');
    await shows(p, '.today');
    const text = await drawn(p);
    check(`invariant 4 (${size.name}): the morning shows none of yesterday's values`, marks.every(m => !text.includes(m)));
  }
  // the marks really are in the record: Practice's total differs with them
  const q = await h.page(LAPTOP, errors);
  const total = async hash => { await h.open(q, hash); await shows(q, '.scr'); return /([\dhm ]+) in all/.exec(await drawn(q))?.[1]; };
  const plain = await total('s=habit&v=h-practice&t=12:30');
  const markedTotal = await total('s=habit&v=h-practice&t=12:30&canary=1');
  check("invariant 4: yesterday's marked values are in the record", plain !== undefined && markedTotal !== undefined && plain !== markedTotal);
}

await h.close();
console.log(`PASS ${ok.length}\n  ${ok.join('\n  ')}`);
console.log(errors.length ? `FAIL ${errors.length}\n  ${errors.join('\n  ')}` : 'FAIL 0');
process.exitCode = errors.length ? 1 : 0;
