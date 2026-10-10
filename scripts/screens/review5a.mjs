// Task 5a review flows. The phone's Back, a picker that could not read the file, Back's order
// through the mounted app, and the cover waiting for the lock screen. Invented data only.
export async function runTask5aReview(h, check, errors, phone, passphrase) {
  const shows = (p, sel, timeout = 8000) => p.waitForSelector(sel, { state: 'attached', timeout }).then(() => true, () => false);
  const gone = (p, sel, timeout = 8000) => p.waitForSelector(sel, { state: 'detached', timeout }).then(() => true, () => false);
  const phoneBack = async p => {
    const left = await p.evaluate(() => window.harness.back());
    await p.sweep?.('phone back');
    return left;
  };
  const setFile = async (p, kind) => {
    const b64 = await p.evaluate(k => window.harness.backup(k), kind);
    await p.setInputFiles('input[type=file]', { name: 'backup.dcbak', mimeType: 'application/octet-stream', buffer: Buffer.from(b64, 'base64url') });
  };

  const p = await h.page(phone, errors);

  await h.open(p, 's=first&v=found');
  await p.tap('[data-a="restore"]');
  await shows(p, '.file-row');
  const leftPick = await phoneBack(p);
  check('phone Back while choosing a file, on an empty phone, returns to first run',
    leftPick === false && await shows(p, '[data-a="restore"]') && (await p.locator('.lk-pass').count()) === 0);

  await h.open(p, 's=first&v=found');
  await p.tap('[data-a="restore"]');
  await shows(p, '.file-row');
  await p.fill('input.pass', passphrase);
  await p.tap('[data-a="restore-go"]');
  check('phone Back on Restored: an empty phone reaches Restored', await shows(p, '[data-a="open"]', 20000));
  const leftDone = await phoneBack(p);
  const lockedEmpty = await shows(p, '.lk-pass', 15000);
  const emptyTitle = (await p.locator('h1.t-l').count()) ? await p.locator('h1.t-l').first().innerText() : '';
  check('phone Back on Restored, on an empty phone, opens the lock the way Open does',
    leftDone === false && lockedEmpty && (await p.locator('[data-a="restore"]').count()) === 0
    && emptyTitle !== 'Restored' && emptyTitle !== 'Restore from a backup');

  await h.open(p, 's=lock&v=damaged');
  await shows(p, '[data-a="lockrestore"]', 15000);
  await p.tap('[data-a="lockrestore"]');
  await shows(p, '[data-a="choose"]');
  await setFile(p, 'mine');
  await p.fill('input.pass', passphrase);
  await p.tap('[data-a="restore-go"]');
  await shows(p, '[data-a="replace"]', 20000);
  await p.tap('[data-a="replace"]');
  check('phone Back on Restored: a lock screen that had a note reaches Restored', await shows(p, '[data-a="open"]', 20000));
  await phoneBack(p);
  const noted = await shows(p, '.lk-pass', 8000) ? await p.locator('.lk-note').count() : -1;
  check('phone Back on Restored clears the old lock-screen note, the way Open does',
    noted === 0 && (await p.locator('.today').count()) === 0 && !(await p.locator('body').innerText()).toLowerCase().includes("can't be opened"));

  await h.open(p, 's=lock&v=damaged');
  await shows(p, '[data-a="lockrestore"]', 15000);
  await p.tap('[data-a="lockrestore"]');
  await shows(p, '[data-a="choose"]');
  await setFile(p, 'mine');
  await p.fill('input.pass', passphrase);
  await p.tap('[data-a="restore-go"]');
  check('phone Back while it asks to replace: the question shows', await shows(p, '[data-a="replace"]', 20000));
  await phoneBack(p);
  check('phone Back while it asks to replace returns to the lock and keeps its note',
    await shows(p, '[data-a="lockrestore"]', 15000)
    && (await p.locator('.lk-note').innerText()).toLowerCase().includes("can't be opened")
    && (await p.locator('[data-a="replace"]').count()) === 0);

  // An open record whose replace drops the keys and then cannot save the copy. A damaged record
  // never reaches this screen: that failure says "Not replaced" and can be tried again.
  await h.open(p, 's=restore&v=replace');
  await shows(p, '[data-a="choose"]');
  await setFile(p, 'source');
  await p.fill('input.pass', passphrase);
  await p.tap('[data-a="restore-go"]');
  await shows(p, '[data-a="replace"]', 20000);
  await p.evaluate(() => window.harness.failCopy('other'));
  await p.tap('[data-a="replace"]');
  check('phone Back on a restore that stopped: the stopped screen shows', await shows(p, '[data-a="restore-stopped"]', 20000));
  await p.evaluate(() => window.harness.holdStatus());
  try {
    await phoneBack(p);
    // Long enough for a 'restored' close to blank the lock and wait on the phone. 'back' does not ask again.
    await p.evaluate(() => new Promise(done => setTimeout(done, 80)));
    const lock = await p.locator('.lk-pass, .lk-finger').count();
    const stillStopped = await p.locator('[data-a="restore-stopped"]').count();
    check('phone Back on a restore that stopped stays back: the lock is already showing, and the phone is not asked again',
      lock > 0 && stillStopped === 0);
  } finally {
    await p.evaluate(() => window.harness.releaseStatus());
  }

  await h.open(p, 's=restore');
  await shows(p, '[data-a="choose"]');
  await setFile(p, 'source');
  await p.evaluate(() => window.harness.pickerFault('unread'));
  await p.tap('[data-a="choose"]');
  const unread = await shows(p, '[data-a="restore-note"]') ? (await p.locator('[data-a="restore-note"]').innerText()).toLowerCase() : '';
  await p.fill('input.pass', passphrase);
  await p.tap('[data-a="restore-go"]');
  const row = await p.locator('.file-row').innerText();
  check('after Not finished, a file chosen before cannot be restored',
    unread.includes('not finished') && unread.includes('stopped') && row.includes('No file chosen yet')
    && (await p.locator('[data-a="open"]').count()) === 0 && (await p.locator('[data-a="replace"]').count()) === 0);

  await h.open(p, 's=today&t=06:05');
  await shows(p, '.today .row');
  await p.tap('[data-a="sheet"]');
  check('phone Back order: the sheet is open', await shows(p, '.sheet[role="dialog"]'));
  const leftSheet = await phoneBack(p);
  check('phone Back closes an open sheet and stays on Today',
    leftSheet === false && await gone(p, '.sheet') && await shows(p, '.today'));
  const leftToday = await phoneBack(p);
  check('phone Back on Today leaves the app and does not change the screen',
    leftToday === true && await shows(p, '.today') && (await p.locator('.sheet').count()) === 0);

  await h.open(p, 's=today&t=06:05');
  await shows(p, '.today');
  const cover = await p.evaluate(async () => {
    const two = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    window.harness.holdStatus();
    await window.harness.leave();
    const jobs = window.harness.resumeHandlers().filter(job => job && typeof job.then === 'function');
    if (jobs.length !== 1) {
      window.harness.releaseStatus();
      return { waited: false, jobs: jobs.length };
    }
    let settled = false;
    jobs[0].then(() => { settled = true; });
    await two();
    const earlyLock = document.querySelector('.lk-pass, .lk-finger') !== null;
    const earlyRecord = document.querySelector('.today') !== null;
    const earlySettled = settled;
    window.harness.releaseStatus();
    await jobs[0];
    await two();
    return {
      waited: true,
      earlyLock,
      earlyRecord,
      earlySettled,
      lateLock: document.querySelector('.lk-pass, .lk-finger') !== null,
      lateRecord: document.querySelector('.today') !== null,
    };
  });
  check('after resume the cover waits until the lock screen is painted, and the record stays hidden',
    cover.waited === true && cover.earlySettled === false && cover.earlyLock === false && cover.earlyRecord === false
    && cover.lateLock === true && cover.lateRecord === false);
}
