// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  return { files, state, remote };
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
      MIRROR_KEY: '/dev/null',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
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
