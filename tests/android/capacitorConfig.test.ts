import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../capacitor.config.ts';

test('the app id, the scheme and the hostname are pinned: together they are the origin every stored row lives under', () => {
  assert.equal(config.appId, 'app.dailycommit');
  assert.equal(config.server?.androidScheme, 'https');
  assert.equal(config.server?.hostname, 'localhost');
  assert.equal(config.server?.url, undefined);          // never a live-reload server
  assert.equal(config.server?.cleartext, undefined);
});

test('nothing can inspect the web view or read its log', () => {
  assert.equal(config.android?.webContentsDebuggingEnabled, false);
  assert.equal(config.loggingBehavior, 'none');
  assert.equal(config.android?.loggingBehavior, 'none');
  assert.equal(config.android?.allowMixedContent, false);
});

test('the app is Daily Commit and ships the release build in dist/', () => {
  assert.equal(config.appName, 'Daily Commit');
  assert.equal(config.webDir, 'dist');
});
