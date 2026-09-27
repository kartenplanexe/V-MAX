export function selectPublicMapglKey(input: {
  isProduction: boolean;
  mapglApiKey: string;
  placesApiKey: string;
  routingApiKey: string;
  backupApiKey?: string;
  tertiaryApiKey?: string;
}) {
  if (!input.mapglApiKey) return '';

  const sharesServerScope = [input.placesApiKey, input.routingApiKey, input.backupApiKey, input.tertiaryApiKey]
    .some(key => key?.trim() === input.mapglApiKey.trim());
  if (input.isProduction && sharesServerScope) return '';
  return input.mapglApiKey;
}
