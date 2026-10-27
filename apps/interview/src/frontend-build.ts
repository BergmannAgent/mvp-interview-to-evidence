const ENTRY_MODULE_SELECTOR = 'script[type="module"][src]';

export function frontendEntryModulesMatch(
  currentSource: string,
  deployedSource: string,
  baseHref: string,
): boolean {
  return (
    normalizeEntryModulePath(currentSource, baseHref) ===
    normalizeEntryModulePath(deployedSource, baseHref)
  );
}

export async function ensureCurrentFrontendBuild(): Promise<boolean> {
  const currentSource = readEntryModuleSource(document);
  if (currentSource === null) return true;

  try {
    const response = await fetch(`/index.html?frontend-build-check=${String(Date.now())}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return true;

    const deployedDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
    const deployedSource = readEntryModuleSource(deployedDocument);
    if (
      deployedSource === null ||
      frontendEntryModulesMatch(currentSource, deployedSource, window.location.href)
    ) {
      return true;
    }

    const refreshUrl = new URL(window.location.href);
    refreshUrl.searchParams.set('frontend-build', String(Date.now()));
    window.location.replace(refreshUrl.href);
    return false;
  } catch {
    return true;
  }
}

function readEntryModuleSource(root: ParentNode): string | null {
  return root.querySelector(ENTRY_MODULE_SELECTOR)?.getAttribute('src') ?? null;
}

function normalizeEntryModulePath(source: string, baseHref: string): string | null {
  try {
    return new URL(source, baseHref).pathname;
  } catch {
    return null;
  }
}
