import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Acceptance-only boundary. Production read supports wider paths, so constrain it here.
export function createLiveMediaTools({ wsRoot, marker, generate, executeFile, readDimensions }) {
  const root = fs.realpathSync(wsRoot), deliveryPath = path.join(root, 'delivery.md');
  const events = [];
  let generationAttempts = 0, image = null, imagePath = null, delivery = null;
  function isolatedFile(file) {
    const real = fs.realpathSync(file), relative = path.relative(root, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(real).isFile())
      throw new Error('artifact must be an isolated regular file');
    return real;
  }
  function assertDelivery(args) {
    if (typeof args.path !== 'string' || path.resolve(root, args.path) !== deliveryPath)
      throw new Error('only isolated delivery.md is allowed');
    if (fs.existsSync(deliveryPath) && isolatedFile(deliveryPath) !== deliveryPath)
      throw new Error('delivery.md may not redirect outside its path');
  }
  function evidenceMatches(content) {
    return image && [marker, image.path, `${image.width}x${image.height}`, image.sha256]
      .every(value => content.includes(value));
  }
  async function execute(name, args = {}, context) {
    if (!['generate_image', 'write', 'read'].includes(name)) throw new Error('tool not allowed');
    if (name === 'generate_image') {
      if (generationAttempts) throw new Error('only one image attempt allowed; uncertain calls must not be retried');
      if (args.size !== '1024x1536' || args.aspect_ratio !== '2:3' || !args.prompt?.trim())
        throw new Error('explicit size 1024x1536 and aspect_ratio 2:3 required');
      generationAttempts++;
      const result = await generate(args, context);
      imagePath = isolatedFile(result.artifactPath);
      const bytes = fs.readFileSync(imagePath), dimensions = readDimensions(bytes);
      if (!dimensions?.width || !dimensions?.height) throw new Error('image dimensions unavailable');
      image = { path: path.relative(root, imagePath).split(path.sep).join('/'),
        ...dimensions, sha256: hash(bytes), bytes: bytes.length, requestedSize: '1024x1536', requestedAspectRatio: '2:3',
        exactSize: dimensions.width === 1024 && dimensions.height === 1536,
        ratioExact: dimensions.width * 3 === dimensions.height * 2 };
      events.push({ name, success: true });
      return { text: JSON.stringify({ image, marker, next: 'Write delivery.md with marker, path, actual WIDTHxHEIGHT and sha256, then read it back.' }) };
    }
    assertDelivery(args);
    if (!image) throw new Error('generate an image first');
    if (name === 'read' && !delivery) throw new Error('write delivery.md before readback');
    const result = await executeFile(name, args, context);
    if (result?.isError || result?.error) throw new Error('file tool failed');
    isolatedFile(deliveryPath);
    const content = fs.readFileSync(deliveryPath, 'utf8'), sha256 = hash(content);
    if (name === 'write') {
      delivery = { path: 'delivery.md', sha256, evidenceMatches: evidenceMatches(content), readbackSha256: null };
    } else {
      if (!content || !result?.text?.includes(content) || delivery.sha256 !== sha256)
        throw new Error('readback did not contain the complete unchanged delivery');
      delivery.readbackSha256 = sha256;
    }
    events.push({ name, success: true });
    return result;
  }
  function report() {
    let unchanged = false;
    try { unchanged = !!image && !!delivery
      && hash(fs.readFileSync(isolatedFile(imagePath))) === image.sha256
      && hash(fs.readFileSync(isolatedFile(deliveryPath))) === delivery.sha256; } catch {}
    const continuationPassed = Boolean(unchanged && delivery.evidenceMatches
      && delivery.sha256 === delivery.readbackSha256);
    const dimensionsPassed = Boolean(image?.exactSize && image?.ratioExact);
    return { generationAttempts, image: image && { ...image }, delivery: delivery && { ...delivery },
      events: events.map(event => ({ ...event })),
      continuationPassed, dimensionsPassed, passed: continuationPassed && dimensionsPassed };
  }
  return { execute, report };
}
