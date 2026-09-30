import {createCultivationStorage} from './storage.mjs';
import {createIdentityAuthority} from './identity.mjs';
import {createCultivationControls} from './controls.mjs';
import {createCultivationProjection} from './projection.mjs';

// No timer, model client or implicit initialization. The production host only
// wires reads until it can supply genuine human grants and mother-run identity.
export function createCultivationRuntime({wsRoot, identityAdapters, verifyAsset, now = Date.now}) {
  const store = createCultivationStorage({wsRoot});
  const authority = createIdentityAuthority({workspace: store.workspace, now, ...identityAdapters});
  const controls = createCultivationControls({store, authority, verifyAsset, now});
  const projection = createCultivationProjection({store});
  const writeIdentityAvailable = typeof identityAdapters?.resolveHuman === 'function' &&
    typeof identityAdapters?.resolveMother === 'function';
  return Object.freeze({
    writeIdentityAvailable,
    overview: () => ({...projection.overview(), writeIdentityAvailable}),
    list: projection.list, detail: projection.detail,
    execute: async (command, kind, trustedSource) => {
      if (!writeIdentityAvailable) throw new Error('cultivation_identity_unavailable');
      return controls.execute(command, authority.issue(kind, trustedSource, command));
    },
  });
}
