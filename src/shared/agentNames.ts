// Default names for new agents: ordinary first names from many languages.
// The user can rename an agent at any time (AgentNameEditor).

export const AGENT_NAME_POOL: readonly string[] = [
  'Aiko', 'Alma', 'Anders', 'Anya', 'Arjun', 'Beatriz', 'Bram', 'Camila', 'Chidi', 'Dagny',
  'Dario', 'Elif', 'Emeka', 'Farah', 'Felix', 'Freya', 'Gabriel', 'Greta', 'Hana', 'Hugo',
  'Ilse', 'Imani', 'Ivan', 'Jana', 'Jonas', 'Kaito', 'Katya', 'Kofi', 'Lars', 'Leila',
  'Lucia', 'Mateo', 'Mei', 'Mirko', 'Nadia', 'Niko', 'Noor', 'Olek', 'Pablo', 'Petra',
  'Priya', 'Quentin', 'Rafael', 'Rania', 'Rosa', 'Sakura', 'Samir', 'Sofia', 'Stefan', 'Tariq',
  'Tereza', 'Tomasz', 'Ulrich', 'Valentina', 'Viktor', 'Wanjiru', 'Wojtek', 'Xiomara', 'Yara', 'Yusuf',
  'Zainab', 'Zofia', 'Anselm', 'Bianca', 'Cosmin', 'Dalia', 'Eero', 'Fatima'
];

/**
 * Pick a name from the pool that is not in `taken` (case-insensitive).
 * When every pool name is taken, a pool name gets a numeric suffix
 * ("Aiko 2", "Aiko 3", ...) until one is free.
 */
export function randomAgentName(taken: readonly string[], rnd: () => number = Math.random): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  const pick = (candidates: readonly string[]): string => {
    const i = Math.min(candidates.length - 1, Math.floor(rnd() * candidates.length));
    return candidates[i];
  };
  const free = AGENT_NAME_POOL.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return pick(free);
  for (let suffix = 2; ; suffix++) {
    const withSuffix = AGENT_NAME_POOL.filter((n) => !used.has(`${n} ${suffix}`.toLowerCase()));
    if (withSuffix.length > 0) return `${pick(withSuffix)} ${suffix}`;
  }
}
