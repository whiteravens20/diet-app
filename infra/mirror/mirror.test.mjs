// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'mirror.sh');
const made = [];

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function aDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
  made.push(dir);
  return dir;
}

/** The instance's files as the API writes them, its state, and an empty repository to copy them to. */
function anInstance() {
  const root = aDirectory();
  const files = join(root, 'files');
  mkdirSync(join(files, 'recipes'), { recursive: true });
  writeFileSync(
    join(files, 'manifest.json'),
    '{"app":"diet-app","version":"0.108.0","recipes":1,"names":1}\n',
  );
  writeFileSync(join(files, 'recipes', 'library.json'), '[{"slug":"oats-with-apple"}]\n');
  writeFileSync(
    join(files, 'ingredient-overrides.json'),
    '{"oats":{"name":{"pl":"Płatki owsiane"}}}\n',
  );
  const state = join(root, 'state');
  mkdirSync(state);
  const report = join(root, 'report');
  mkdirSync(report);
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  return { files, state, report, remote };
}

/** One round of the copy, as the service runs it, with the repository at a local address. */
function aRound(instance) {
  const run = spawnSync('sh', [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      MIRROR_ONCE: '1',
      MIRROR_REPO: instance.remote,
      MIRROR_NAME: 'kitchen',
      MIRROR_FILES: instance.files,
      MIRROR_STATE: instance.state,
      MIRROR_REPORT: instance.report,
      MIRROR_KEY: '/dev/null',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

/** What the round left for the admin panel. */
function theReport(instance) {
  return JSON.parse(readFileSync(join(instance.report, 'status.json'), 'utf8'));
}

/** The repository as somebody who clones it finds it. */
function theRepository(instance) {
  const look = aDirectory();
  execFileSync('git', ['clone', '-q', instance.remote, look]);
  return look;
}

test("copies the instance's files into an empty repository, with a README, signed with the instance's name", () => {
  const instance = anInstance();

  const said = aRound(instance);

  assert.match(said, /pushed a commit/);
  const look = theRepository(instance);
  for (const file of ['manifest.json', 'recipes/library.json', 'ingredient-overrides.json']) {
    assert.equal(
      readFileSync(join(look, file), 'utf8'),
      readFileSync(join(instance.files, file), 'utf8'),
    );
  }
  assert.match(
    readFileSync(join(look, 'README.md'), 'utf8'),
    /^# Diet App instance files: kitchen\n/,
  );
  assert.equal(
    git(look, 'log', '-1', '--format=%an <%ae>'),
    'kitchen-mirror <kitchen-mirror@diet-app.invalid>',
  );
  assert.equal(git(look, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('commits nothing when nothing changed', () => {
  const instance = anInstance();
  aRound(instance);

  aRound(instance);

  assert.equal(git(instance.remote, 'rev-list', '--count', 'main'), '1');
});

test("follows what the instance removed, leaves out a file it is still writing, and keeps the operator's README", () => {
  const instance = anInstance();
  aRound(instance);
  // The operator rewrites the README in the repository itself.
  const operator = theRepository(instance);
  writeFileSync(join(operator, 'README.md'), '# Diet App instance files: kitchen\n\nOurs.\n');
  git(
    operator,
    '-c',
    'user.name=Operator',
    '-c',
    'user.email=op@example.test',
    'commit',
    '-qam',
    'Our README',
  );
  git(operator, 'push', '-q', 'origin', 'main');
  rmSync(join(instance.files, 'ingredient-overrides.json'));
  writeFileSync(join(instance.files, 'manifest.json.writing'), '{"app"');

  aRound(instance);

  const look = theRepository(instance);
  assert.equal(existsSync(join(look, 'ingredient-overrides.json')), false);
  assert.equal(existsSync(join(look, 'manifest.json.writing')), false);
  assert.equal(
    readFileSync(join(look, 'README.md'), 'utf8'),
    '# Diet App instance files: kitchen\n\nOurs.\n',
  );
  assert.equal(git(look, 'rev-list', '--count', 'main'), '3');
});

test('refuses a repository that holds files of something else, and changes nothing in it', () => {
  const instance = anInstance();
  const owner = aDirectory();
  git(owner, 'clone', '-q', instance.remote, '.');
  mkdirSync(join(owner, 'src'));
  writeFileSync(join(owner, 'src', 'main.c'), 'int main(void) { return 0; }\n');
  git(owner, 'add', '-A');
  git(
    owner,
    '-c',
    'user.name=Owner',
    '-c',
    'user.email=owner@example.test',
    'commit',
    '-qm',
    'Code',
  );
  git(owner, 'push', '-q', 'origin', 'main');

  const said = aRound(instance);

  assert.match(
    said,
    /holds files of something else, src among them: give the copy an empty repository of its own/,
  );
  assert.equal(git(instance.remote, 'rev-list', '--count', 'main'), '1');
});

test('takes up a repository it wrote to before, after its own clone was lost', () => {
  const instance = anInstance();
  aRound(instance);
  rmSync(instance.state, { recursive: true });
  mkdirSync(instance.state);

  const said = aRound(instance);

  assert.doesNotMatch(said, /something else/);
  assert.equal(git(instance.remote, 'rev-list', '--count', 'main'), '1');
});

test('reports a round that pushed: when, how often, and what the repository holds', () => {
  const instance = anInstance();

  aRound(instance);

  const report = theReport(instance);
  assert.equal(report.result, 'ok');
  assert.equal(report.every, 3600);
  assert.match(report.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(report.pushedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(
    Date.parse(report.pushedAt),
    Number(git(instance.remote, 'log', '-1', '--format=%ct', 'main')) * 1000,
  );
  assert.equal(
    readFileSync(join(instance.report, 'copy.json'), 'utf8'),
    readFileSync(join(instance.files, 'manifest.json'), 'utf8'),
  );
  assert.deepEqual(readdirSync(instance.report).sort(), ['copy.json', 'status.json']);
});

test('keeps the time of the last push through a round with nothing to push, and of none by the operator', () => {
  const instance = anInstance();
  aRound(instance);
  const { pushedAt } = theReport(instance);
  const operator = theRepository(instance);
  writeFileSync(join(operator, 'README.md'), '# Diet App instance files: kitchen\n\nOurs.\n');
  git(
    operator,
    '-c',
    'user.name=Operator',
    '-c',
    'user.email=op@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qam',
    'Our README',
    '--date=2030-01-01T00:00:00Z',
  );
  execFileSync('git', ['push', '-q', 'origin', 'main'], {
    cwd: operator,
    env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' },
  });

  aRound(instance);

  assert.equal(theReport(instance).result, 'ok');
  assert.equal(theReport(instance).pushedAt, pushedAt);
});

test('tells nothing of the repository in its report', () => {
  const instance = anInstance();
  aRound(instance);

  const told = readFileSync(join(instance.report, 'status.json'), 'utf8');

  assert.equal(told.includes(instance.remote), false);
  assert.equal(told.includes('kitchen'), false);
});

for (const [what, manifest] of [
  ['no manifest', null],
  [
    'nothing in its manifest',
    '{\n  "app": "diet-app",\n  "version": "0.150.0",\n  "recipes": 0,\n  "names": 0\n}\n',
  ],
]) {
  test(`leaves the repository alone when the instance has ${what}, as after an emptied volume`, () => {
    const instance = anInstance();
    aRound(instance);
    const { pushedAt } = theReport(instance);
    rmSync(instance.files, { recursive: true });
    mkdirSync(instance.files);
    if (manifest) writeFileSync(join(instance.files, 'manifest.json'), manifest);

    const said = aRound(instance);

    assert.match(said, /the repository stays as it is/);
    const look = theRepository(instance);
    assert.equal(existsSync(join(look, 'recipes', 'library.json')), true);
    assert.equal(git(instance.remote, 'rev-list', '--count', 'main'), '1');
    assert.equal(theReport(instance).result, 'empty');
    assert.equal(theReport(instance).pushedAt, pushedAt);
  });
}

test('goes on copying an instance that holds names and no recipes', () => {
  const instance = anInstance();
  writeFileSync(
    join(instance.files, 'manifest.json'),
    '{\n  "app": "diet-app",\n  "version": "0.150.0",\n  "recipes": 0,\n  "names": 12\n}\n',
  );

  aRound(instance);

  assert.equal(theReport(instance).result, 'ok');
  assert.equal(git(instance.remote, 'rev-list', '--count', 'main'), '1');
});

test('reports a repository it cannot clone, with no time of a push', () => {
  const instance = anInstance();
  instance.remote = join(instance.report, '..', 'no-such-repository.git');

  aRound(instance);

  assert.deepEqual((({ result, pushedAt }) => ({ result, pushedAt }))(theReport(instance)), {
    result: 'clone',
    pushedAt: null,
  });
});

test('reports a repository that holds files of something else', () => {
  const instance = anInstance();
  const owner = aDirectory();
  git(owner, 'clone', '-q', instance.remote, '.');
  writeFileSync(join(owner, 'main.c'), 'int main(void) { return 0; }\n');
  git(owner, 'add', '-A');
  git(
    owner,
    '-c',
    'user.name=Owner',
    '-c',
    'user.email=owner@example.test',
    'commit',
    '-qm',
    'Code',
  );
  git(owner, 'push', '-q', 'origin', 'main');

  aRound(instance);

  assert.equal(theReport(instance).result, 'foreign');
});

test('reports a repository that went away, keeping what it knew of the last push', () => {
  const instance = anInstance();
  aRound(instance);
  const { pushedAt } = theReport(instance);
  renameSync(instance.remote, `${instance.remote}.gone`);

  aRound(instance);

  assert.equal(theReport(instance).result, 'unreachable');
  assert.equal(theReport(instance).pushedAt, pushedAt);
});

test('reports a push that was refused, and the last one that reached the repository', () => {
  const instance = anInstance();
  aRound(instance);
  const { pushedAt } = theReport(instance);
  const hook = join(instance.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(instance.files, 'recipes', 'library.json'), '[{"slug":"pancakes"}]\n');

  const said = aRound(instance);

  assert.match(said, /could not push/);
  assert.equal(theReport(instance).result, 'push');
  assert.equal(theReport(instance).pushedAt, pushedAt);
});

test('pushes in a later round what the first could not, once the repository takes it', () => {
  const instance = anInstance();
  const hook = join(instance.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);

  aRound(instance);

  assert.equal(theReport(instance).result, 'push');
  assert.equal(theReport(instance).pushedAt, null);

  // The next round may find the repository as it was, and says so again.
  aRound(instance);

  assert.equal(theReport(instance).result, 'push');

  // The operator gave the key write access.
  rmSync(hook);
  const said = aRound(instance);

  assert.match(said, /pushed a commit/);
  assert.equal(theReport(instance).result, 'ok');
  assert.notEqual(theReport(instance).pushedAt, null);
  assert.equal(git(instance.remote, 'rev-list', '--count', 'main'), '1');
  assert.equal(existsSync(join(theRepository(instance), 'manifest.json')), true);
});

test("is the script the release's Compose file carries", () => {
  const compose = readFileSync(join(HERE, '..', 'docker-compose.prod.yml'), 'utf8').split('\n');
  const service = compose.indexOf('  mirror:');
  assert.notEqual(service, -1, 'the release compose has no mirror service');
  const start = compose.indexOf('    entrypoint:', service);
  assert.notEqual(start, -1, 'the mirror service has no entrypoint');
  assert.deepEqual(compose.slice(start + 1, start + 4), ['      - sh', '      - -c', '      - |']);
  const carried = [];
  for (const line of compose.slice(start + 4)) {
    if (line !== '' && !line.startsWith('        ')) break;
    carried.push(line.slice(8));
  }
  // Compose reads `$$` as a `$` it does not fill in.
  const script = carried.join('\n').replaceAll('$$', '$').trimEnd() + '\n';
  assert.equal(script, readFileSync(SCRIPT, 'utf8'));
});

test("is in no config of the release's Compose file, which a read-only service cannot take", () => {
  // Compose copies a config given as `content` into the container, and refuses that for a
  // service whose root file system is read-only, as the mirror's is.
  const compose = readFileSync(join(HERE, '..', 'docker-compose.prod.yml'), 'utf8').split('\n');
  assert.deepEqual(
    compose.filter((line) => /^\s*content:/.test(line)),
    [],
  );
});
