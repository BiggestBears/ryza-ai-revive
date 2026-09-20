/* The two things every screenshot/probe script needs, in one place:

     puppeteer — where `puppeteer-core` comes from. It is NOT vendored in this
                 repo (it used to be reached through an absolute path into one
                 developer's disk, which is both unportable and — since
                 scripts/ is published — a privacy problem; the project's own
                 privacy_check refuses machine paths and account names).
                 Resolution order:
                   1. $RYZA_PUPPETEER_CORE — a directory containing
                      node_modules/puppeteer-core, or puppeteer-core itself
                   2. the normal `require('puppeteer-core')` lookup, so
                      `npm i puppeteer-core` next to the repo also works
     SHOTS     — where the PNGs go. $RYZA_SHOTS, else temp/shots (gitignored
                 and disposable, per the project's temp/ rule).
     EDGE      — the browser binary those probes drive. $RYZA_BROWSER, else the
                 stock Windows Edge path (not a personal path: same on every
                 Windows box).

   Nothing here may ever hold an absolute path to a specific disk again. */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadPuppeteer() {
  const dir = process.env.RYZA_PUPPETEER_CORE;
  if (dir) {
    for (const cand of [path.join(dir, 'node_modules', 'puppeteer-core'),
                        path.join(dir, 'puppeteer-core'),
                        dir]) {
      try { return require(cand); } catch (e) { /* try the next shape */ }
    }
    throw new Error('RYZA_PUPPETEER_CORE=' + dir + ' has no puppeteer-core in it');
  }
  try {
    return require('puppeteer-core');
  } catch (e) {
    throw new Error('puppeteer-core not found. Install it (npm i puppeteer-core) ' +
      'or point RYZA_PUPPETEER_CORE at a directory that has it. Original: ' + e.message);
  }
}

const SHOTS = process.env.RYZA_SHOTS || path.join(ROOT, 'temp', 'shots');
const EDGE = process.env.RYZA_BROWSER ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

module.exports = { puppeteer: loadPuppeteer(), SHOTS, EDGE, ROOT };
