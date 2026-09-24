/** Only signed launch data is accepted; initDataUnsafe is not an authentication source. */
export function readMaxLaunchData(bridgeData: string | undefined, fragment: string): string {
  const parameters = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  return bridgeData || parameters.get('WebAppData') || '';
}

export async function waitForMaxLaunchData(read: () => string, attempts = 10): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = read();
    if (data) return data;
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 150));
  }
  return '';
}
