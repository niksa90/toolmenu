import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionOf } from '../action/version.mjs';

test('action: the release version from package.json, pyproject.toml or Cargo.toml', () => {
  assert.equal(versionOf('package.json', '{"name":"srv","version":"1.4.0"}'), '1.4.0');
  assert.equal(versionOf('package.json', '{"name":"srv"}'), undefined);
  assert.equal(versionOf('package.json', 'not json'), undefined);
  assert.equal(versionOf('pyproject.toml', '[project]\nname = "srv"\nversion = "0.3.1"\n'), '0.3.1');
  assert.equal(versionOf('pyproject.toml', "[tool.poetry]\nversion = '2.0.0'\n"), '2.0.0');
  assert.equal(versionOf('pyproject.toml', '[project]\ndynamic = ["version"]\n[tool.other]\nversion = "9.9.9"\n'), undefined, 'a version from git tags, or another table, is not the release');
  assert.equal(versionOf('Cargo.toml', '[package]\nname = "srv"\nversion = "2.1.0"\n[dependencies]\nserde = { version = "1" }\n'), '2.1.0');
  assert.equal(versionOf('Cargo.toml', '[package]\nversion.workspace = true\n'), undefined);
  assert.equal(versionOf('go.mod', 'module x'), undefined);
});
