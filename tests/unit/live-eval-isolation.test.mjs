import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Entry-point ordering is a safety contract: engine imports may capture workspace paths.
for (const script of ['eval-team-general.mjs', 'eval-media-continuation.mjs']) {
  test(script + ' isolates the workspace before loading any engine modules', () => {
    const source = fs.readFileSync(new URL('../../scripts/' + script, import.meta.url), 'utf8');
    const lines = source.split(String.fromCharCode(10));
    assert.equal(lines.some(line => line.startsWith('import ') && line.includes('../engine/')), false,
      'no static engine import is allowed before the live gate and workspace isolation');
    const gate = source.indexOf("if (!process.argv.includes('--live'))");
    const root = source.indexOf('const wsRoot = fs.mkdtempSync(');
    const primary = source.indexOf('process.env.YUANSHU_CWD = wsRoot');
    const compat = source.indexOf('process.env.PI_WEB_CWD = wsRoot');
    const engine = source.indexOf("await import('../engine/");
    assert.ok(gate >= 0 && root > gate, 'paid opt-in must precede even workspace creation');
    assert.ok(primary > root && compat > root, 'both workspace variables must point to the temporary root');
    assert.ok(engine > primary && engine > compat, 'engine initialization must follow isolation');
  });
}
