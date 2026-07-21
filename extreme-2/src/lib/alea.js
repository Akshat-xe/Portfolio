// Alea PRNG — deterministic, seedable, ~4x faster than Math.random in V8.
// A given seed string always yields the identical stream across sessions and
// browsers, which is what makes a world "seed" shareable.

function masher() {
  let n = 0xefc8249d;
  return function mash(data) {
    const s = String(data);
    for (let i = 0; i < s.length; i++) {
      n += s.charCodeAt(i);
      let h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000;
    }
    return (n >>> 0) * 2.3283064365386963e-10;
  };
}

export function alea(seed = 'akshat') {
  const mash = masher();
  let s0 = mash(' ');
  let s1 = mash(' ');
  let s2 = mash(' ');
  let c = 1;

  s0 -= mash(seed); if (s0 < 0) s0 += 1;
  s1 -= mash(seed); if (s1 < 0) s1 += 1;
  s2 -= mash(seed); if (s2 < 0) s2 += 1;

  const rng = function () {
    const t = 2091639 * s0 + c * 2.3283064365386963e-10;
    s0 = s1;
    s1 = s2;
    return (s2 = t - (c = t | 0));
  };

  rng.int32 = () => (rng() * 0x100000000) | 0;
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[(rng() * arr.length) | 0];
  return rng;
}

// Cheap positional hash -> [0,1). Used for scatter decisions where we need a
// deterministic value for a coordinate without keeping any state around.
export function hash2(x, y, salt = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (salt | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
