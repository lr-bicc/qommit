const APP_CONTENT_GUID_RE = /\/appcontent\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\//g;

/** Replaces the app id of every `/appcontent/<GUID>/` url; text that is not a GUID there stays untouched. */
export function replaceAppContentIds(text: string, appId: string): string {
  return text.replace(APP_CONTENT_GUID_RE, () => `/appcontent/${appId}/`);
}
