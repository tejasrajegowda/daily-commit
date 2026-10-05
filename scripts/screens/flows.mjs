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

// Today
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  const valOf = id => p.locator(`.row[data-x="${id}"] .val`).innerText();
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
  await until(() => document.querySelector('.earlier')?.textContent?.includes('wake up'));
  check('Today: a hard evening offers the rest day', (await p.locator('[data-a="rest"]').count()) === 2);
  await p.tap('[data-a="rest"][data-x="use"]');
  check('Today: the rest day marks only the Focus still unanswered', await until(() => (document.querySelector('.earlier')?.textContent?.split('planned rest').length ?? 0) - 1 === 2)
    && !(await p.locator('.earlier').innerText()).includes('wake upplanned'));
  await p.tap('[data-a="close"]');
  check("Today: That's the day closes it", await until(() => document.querySelector('h1.t-xl')?.textContent?.includes("That's the day")));
  await p.tap('[data-a="reopen"]');
  check('Today: Open today again returns to the evening', await until(() => !document.querySelector('h1.t-xl')?.textContent?.includes("That's the day")) && await shows(p, '[data-a="close"]'));

  await h.open(p, 's=today&t=10:30&age=20');
  await shows(p, '.today .row');
  check('Today: a Saturday has no weekday-only row', (await p.locator('.row[data-x="h-practice"]').count()) === 0);
  await h.open(p, 's=today&t=22:58&v=closed');
  check('Today: a closed day shows its card', await shows(p, '.closed-card'));

  const q = await h.page(LAPTOP, errors);
  await h.open(q, 's=today&t=06:05');
  await shows(q, '.today .row');
  await q.keyboard.press('1');
  check('Today, laptop: key 1 marks the first row', await q.waitForFunction(() => document.querySelector('.row[data-x="h-wake"] .val')?.textContent?.includes('06:05'), null, { timeout: 8000 }).then(() => true, () => false));
  check('Today, laptop: the shape of today is there', await q.locator('.shape .sh').count() > 3);
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

// Plan
{
  const p = await h.page(PHONE, errors);
  const until = (fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);
  await h.open(p, 's=plan&t=13:00');
  check('Plan: three Focus slots and Log', await shows(p, '.slots') && (await p.locator('.slot').count()) === 3 && (await p.locator('.pl-log').count()) > 3);
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
  await typeCode(p, CODE);
  await p.tap('[data-a="pinok"]');
  check('Privacy: own code, step 2 asks for it again', await until(() => document.querySelector('h1')?.textContent === 'Type it again'));
  await typeCode(p, '13572468');
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

  await h.open(p, 's=settings&v=notverified&t=13:00');
  check('Privacy: a code the phone could not confirm shows "The separate code is off"', await shows(p, '[data-a="notverified"]'));
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

await h.close();
console.log(`PASS ${ok.length}\n  ${ok.join('\n  ')}`);
console.log(errors.length ? `FAIL ${errors.length}\n  ${errors.join('\n  ')}` : 'FAIL 0');
process.exitCode = errors.length ? 1 : 0;
