const checkInterval = 10 * 60_000;

export async function checkBuild(loadedBuild, banner, request = fetch) {
  try {
    const response = await request('/api/build', {cache:'no-store', signal:AbortSignal.timeout(5000)});
    if (!response.ok) return;
    const body = await response.json();
    if (Number.isSafeInteger(body?.build) && body.build > 0) banner.hidden = body.build === loadedBuild;
  } catch {
    // Retain the last known status when the server is unreachable.
  }
}

if (typeof document !== 'undefined') {
  const loadedBuild = Number(document.querySelector('meta[name="honeymoon-build"]')?.content);
  const banner = document.getElementById('build-outdated');
  if (Number.isSafeInteger(loadedBuild) && loadedBuild > 0 && banner) {
    document.getElementById('build-caption').textContent = 'Equestria · Сборка ' + loadedBuild;
    const check = () => void checkBuild(loadedBuild, banner);
    check();
    setInterval(check, checkInterval);
  }
}
