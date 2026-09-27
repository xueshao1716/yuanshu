// Fixed, offline runner. No command strings, model calls, downloads or workspace writes.
import { reconcileImageMessages } from '../frontend/src/lib/image-identity.ts';
import { measureImageExperiment } from '../engine/mechanism-image-cases.mjs';
process.stdout.write(JSON.stringify({ cases: measureImageExperiment(reconcileImageMessages) }));
