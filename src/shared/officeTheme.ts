// Office theme ids this build knows about. A saved id outside the list (for
// example the removed 'brooklyn99') falls back to the plain office.

export const KNOWN_OFFICE_THEMES: readonly string[] = ['office', 'friends', 'siliconvalley', 'got', 'hogwarts'];

export function normalizeOfficeTheme(id: string | undefined | null): string {
  return id && KNOWN_OFFICE_THEMES.includes(id) ? id : 'office';
}
