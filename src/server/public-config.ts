export function selectPublicMapglKey(input: {
  isProduction: boolean;
  mapglApiKey: string;
  placesApiKey: string;
  routingApiKey: string;
}) {
  if (!input.mapglApiKey) return '';

  const sharesServerScope =
    input.mapglApiKey === input.placesApiKey || input.mapglApiKey === input.routingApiKey;
  if (input.isProduction && sharesServerScope) return '';
  return input.mapglApiKey;
}
