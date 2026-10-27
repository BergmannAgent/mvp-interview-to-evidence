export function mediaTypeEssence(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  const essence = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return essence === undefined || essence.length === 0 ? undefined : essence;
}
