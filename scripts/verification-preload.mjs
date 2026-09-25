// Use existing dependency-injection points; never relocate the user's HOME.
import fs from 'node:fs';
import path from 'node:path';
import { initFileLock } from '../engine/file-lock.mjs';
import { initYuanshuWorkmem } from '../engine/yuanshu-workmem.mjs';

const root = process.env.YUANSHU_VERIFICATION_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Verification requires an absolute isolated root');
fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
initFileLock({ dir: path.join(root, 'agent/locks') });
initYuanshuWorkmem(path.join(root, 'agent/workmem'));
