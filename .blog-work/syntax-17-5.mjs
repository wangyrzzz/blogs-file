// storage、jobs、events 是项目适配器；下面是控制流伪代码。
export async function processImageEvent(event) {
  const source = events.parseAndValidate(event);
  if (!source.key.startsWith('originals/')) return { ignored: true };
  const identity = jobs.identity(source, 'thumbnail-v3');
  const claim = await jobs.tryClaim(identity);
  if (!claim.acquired) return { duplicateOrBusy: true };
  try {
    const bytes = await storage.readBounded(source, MAX_SOURCE_BYTES);
    const result = await makeThumbnail(bytes);
    const outputKey = jobs.outputKey(identity);
    await storage.putCompleteObject(outputKey, result.bytes, result.contentType);
    await jobs.markSuccessIfOwner(identity, claim.ownerToken, outputKey, result);
    return { completed: true };
  } catch (failure) {
    await jobs.recordFailureIfOwner(identity, claim.ownerToken, failure);
    throw failure;
  }
}