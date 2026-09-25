import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';

function outsideSelection(html,targetId) {
  const {document}=parseHTML(`<html><body>${html}</body></html>`);
  const targets=[...document.body.querySelectorAll('[id]')].filter(el=>el.id===targetId);
  assert.equal(targets.length,1,'Selection must exist exactly once');
  // Keep a marker at the exact position: removal alone would miss a moved selection.
  targets[0].replaceWith(document.createComment('selected-element'));
  return document.body.innerHTML;
}

export function assertOutsideSelectionUnchanged(before,after,targetId) {
  assert.equal(after.css,before.css,'Global CSS must remain unchanged');
  assert.equal(outsideSelection(after.html,targetId),outsideSelection(before.html,targetId),
    'Outside selection must remain unchanged');
}
