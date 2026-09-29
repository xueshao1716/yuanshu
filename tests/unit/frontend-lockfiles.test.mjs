import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('frontend npm and pnpm importers match every direct dependency specifier', () => {
  const dir = new URL('../../frontend/', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', dir), 'utf8'));
  const npmLock = JSON.parse(fs.readFileSync(new URL('package-lock.json', dir), 'utf8'));
  const npm = npmLock.packages[''];
  const yaml = fs.readFileSync(new URL('pnpm-lock.yaml', dir), 'utf8');
  // Read only the generated importer's scalar specifiers, not arbitrary YAML.
  const importer = yaml.split(/\r?\npackages:/)[0];
  const pnpm = {}, versions = {}; let section, name;
  for (const line of importer.split(/\r?\n/)) {
    const group = line.match(/^    (dependencies|devDependencies|optionalDependencies):$/);
    if (group) { section = group[1]; pnpm[section] = {}; continue; }
    const entry = line.match(/^      (.+):$/);
    if (entry) name = entry[1].replace(/^['"]|['"]$/g, '');
    const specifier = line.match(/^        specifier: (.+)$/);
    if (specifier && section && name) pnpm[section][name] = specifier[1].replace(/^['"]|['"]$/g, '');
    const version = line.match(/^        version: ([^( ]+)/);
    if (version && name) versions[name] = version[1];
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.deepEqual(npm[section] || {}, pkg[section] || {}, `npm ${section} out of sync`);
    assert.deepEqual(pnpm[section] || {}, pkg[section] || {}, `pnpm ${section} out of sync`);
    for (const name of Object.keys(pkg[section] || {})) {
      assert.equal(versions[name], npmLock.packages[`node_modules/${name}`]?.version, `${name} locked version differs`);
    }
  }
});
