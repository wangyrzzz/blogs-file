export async function handler(event) {
  for (const record of event.objects) {
    const objectKey = record.key;
    if (!isAllowedImage(objectKey, record.contentType, record.size)) {
      await markFailed(objectKey, 'unsupported image');
      continue;
    }

    const source = await storage.get(objectKey);
    const metadata = await image.readMetadata(source);
    if (metadata.width > 10000 || metadata.height > 10000) {
      await markFailed(objectKey, 'image is too large');
      continue;
    }

    const thumbnail = await image.resize(source, { width: 800, format: 'webp' });
    await storage.put(`${objectKey}/thumbnail.webp`, thumbnail);
    await markSucceeded(objectKey);
  }
}