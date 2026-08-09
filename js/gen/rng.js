// Seeded randomness for the pattern generator.
//
// Every generator function takes an rng argument and calls no global random.
// That is what makes a seed reproducible and a module testable — and it is the
// reason this file exists at all rather than `Math.random()` being sprinkled
// about.
//
// The other half of the design is `rngFor(seed, tag)`: each part draws from its
// **own stream**, derived from the seed and a tag ('bass', 'lead', 'lead.motif').
// One shared stream would mean nudging the lead's density reshuffles the bass,
// because every draw after the change lands one place further along. Independent
// streams are what make the seed lock feel right: lock it, move one slider, and
// only the part you touched changes.
//
// mulberry32 is the PRNG: 32 bits of state, a handful of integer ops, no
// dependencies, and good enough for musical decisions. It is not for anything
// that needs to be unguessable.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seed + tag → a 32-bit stream id. FNV-1a over the tag, then an avalanche mix,
// because adjacent seeds and adjacent tags ('bass' / 'bass2') must not produce
// streams that march in step with each other — which is exactly what a plain
// `seed + tagLength` style derivation would do.
export function hashTag(tag, seed = 0) {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  const s = String(tag);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// An independent stream for one part of the generation, from the song's seed.
export const rngFor = (seed, tag) => mulberry32(hashTag(tag, seed));

// A fresh song seed. The one place in the generator allowed to reach for global
// randomness, because "roll the dice" is precisely what it means — and it is
// called from the UI, never from a generator function.
export const randomSeed = () => Math.floor(Math.random() * 4294967296) >>> 0;

// --- Drawing from a stream -----------------------------------------------------

export const chance = (rng, p) => rng() < p;

export const range = (rng, lo, hi) => lo + rng() * (hi - lo);

// Inclusive at both ends, which is what every musical use of it wants
// (`intRange(rng, 1, 4)` is "one to four notes").
export const intRange = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

export function pick(rng, items) {
  if (!items?.length) return null;
  return items[Math.floor(rng() * items.length)];
}

// Weighted pick. `weightOf` defaults to reading `.weight`, so both a list of
// plain numbers-with-weights and a list of descriptors work. Non-positive
// weights can never be picked; all-zero weights fall back to a uniform pick
// rather than returning null, because a caller asking for one of N things wants
// one of N things.
export function weighted(rng, items, weightOf = it => it.weight ?? 0) {
  if (!items?.length) return null;
  const ws = items.map(it => Math.max(0, weightOf(it)));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return pick(rng, items);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

// N distinct items, weighted, without replacement — the draw the rhythm table
// needs (pick 9 of 32 steps, favouring the strong ones).
//
// Efraimidis–Spirakis: give each item the key `rng() ** (1 / weight)` and take
// the largest keys. One pass, one random number per item, and provably the same
// distribution as repeated weighted draws with removal — which matters here
// because the alternative (draw, remove, redraw) walks the stream a variable
// number of times and so makes the result depend on how many collisions
// happened, not just on the seed.
export function sampleWeighted(rng, items, n, weightOf = it => it.weight ?? 0) {
  if (n <= 0 || !items?.length) return [];
  const keyed = items.map(it => {
    const w = Math.max(0, weightOf(it));
    return { it, key: w <= 0 ? -1 : Math.pow(rng(), 1 / w) };
  });
  return keyed
    .filter(k => k.key >= 0)
    .sort((a, b) => b.key - a.key)
    .slice(0, n)
    .map(k => k.it);
}

// Fisher–Yates, on a copy.
export function shuffle(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
