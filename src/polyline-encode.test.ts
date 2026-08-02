// Node environment (no DOM needed) — see vitest.config.ts.
//
// Fixtures below are HAND-COMPUTED from the algorithm's own definition
// (https://developers.google.com/maps/documentation/utilities/polylinealgorithm),
// not copied from a remembered "canonical" string, so each one is checked by
// working the zigzag + 5-bit-chunk arithmetic by hand rather than trusting
// recall of a byte-exact reference string. The round-trip tests use an
// independent decoder implemented here (the mirror of the encode algorithm)
// to check realistic multi-point routes stay correct within precision-5
// rounding — this module ships no decoder itself (see its module doc).
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLYLINE_PRECISION,
  encodePolyline,
  type LngLatCoord,
} from "./polyline-encode.ts";

/** Mirror decoder, precision-5 (or whatever `precision` is passed) — the
 *  standard inverse of the encode algorithm. Test-only: the module under
 *  test never needs to decode (the server owns that). Returns `[lng, lat]`
 *  pairs to match `encodePolyline`'s input order. */
function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = Math.pow(10, precision);
  let index = 0;
  let lat = 0;
  let lng = 0;
  const out: [number, number][] = [];
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    out.push([lng / factor, lat / factor]);
  }
  return out;
}

describe("encodePolyline — hand-computed fixtures (precision 5)", () => {
  it("a single point at the origin encodes both deltas as the zero char '?'", () => {
    // lat*1e5=0, lng*1e5=0 → both deltas 0 → encodeUnsignedNumber(0) is a
    // single char, charCode(0+63)=63='?', for each of the two coordinates.
    expect(encodePolyline([[0, 0]])).toBe("??");
  });

  it("a +1-unit latitude delta (0.00001°) encodes as 'A', longitude stays '?'", () => {
    // delta=1 → zigzag = 1<<1 = 2 (non-negative) → single char (2+63)=65='A'.
    expect(encodePolyline([[0, 0.00001]])).toBe("A?");
  });

  it("a -1-unit latitude delta encodes as '@' (the zigzag negative case)", () => {
    // delta=-1 → zigzag = ~(-1<<1) = ~(-2) = 1 → single char (1+63)=64='@'.
    expect(encodePolyline([[0, -0.00001]])).toBe("@?");
  });

  it("a +32-unit delta needs a continuation byte ('_A')", () => {
    // delta=32 → zigzag=64. 64>=0x20: first chunk = (0x20 | (64&0x1f))+63
    // = (0x20|0)+63 = 95 = '_'; remainder 64>>5=2 → final chunk (2+63)=65='A'.
    expect(encodePolyline([[0, 0.00032]])).toBe("_A?");
  });

  it("two sequential points delta-encode against the running total, not the origin", () => {
    // Point 1 (0,0) → "??". Point 2 (0, 0.00001): lat delta is 1 relative to
    // point 1's accumulated lat (0), same 'A' as the single-point case above.
    expect(encodePolyline([[0, 0], [0, 0.00001]])).toBe("??A?");
  });

  it("negative longitude also zigzags correctly (Denver-shaped coordinates)", () => {
    // lng=-104.99030 → *1e5 = -10499030 (exact, no rounding surprise).
    // delta = -10499030 → zigzag = ~(-10499030<<1) = ~(-20998060) = 20998059.
    // This is checked against the mirror decoder below rather than a second
    // hand-expansion of a 25-bit number — decode(encode(x)) == x is exactly
    // what the format has to guarantee, and the decoder is the independent
    // implementation of the inverse arithmetic.
    const coords: LngLatCoord[] = [[-104.9903, 39.7392]];
    const encoded = encodePolyline(coords);
    const [decoded] = decodePolyline(encoded);
    expect(decoded[0]).toBeCloseTo(-104.9903, 5);
    expect(decoded[1]).toBeCloseTo(39.7392, 5);
  });

  it("defaults to precision 5 when the argument is omitted", () => {
    expect(encodePolyline([[0, 0.00001]])).toBe(
      encodePolyline([[0, 0.00001]], DEFAULT_POLYLINE_PRECISION),
    );
    expect(DEFAULT_POLYLINE_PRECISION).toBe(5);
  });
});

describe("encodePolyline — round-trip via the mirror decoder", () => {
  it("round-trips a realistic multi-point Denver route within precision-5 rounding", () => {
    const route: LngLatCoord[] = [
      [-104.9903, 39.7392],
      [-104.9915, 39.7405],
      [-104.9887, 39.7421],
      [-104.985, 39.743],
      [-104.9822, 39.7418],
    ];
    const encoded = encodePolyline(route);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(route.length);
    // Half of one precision-5 step (1e-5°) is the worst-case rounding error
    // per coordinate; toBeCloseTo(…, 5) checks to 5 decimal places directly.
    for (let i = 0; i < route.length; i += 1) {
      expect(decoded[i][0]).toBeCloseTo(route[i][0], 5);
      expect(decoded[i][1]).toBeCloseTo(route[i][1], 5);
    }
  });

  it("round-trips at a non-default precision (6)", () => {
    const route: LngLatCoord[] = [
      [-104.9903, 39.7392],
      [-104.9756, 39.7501],
    ];
    const encoded = encodePolyline(route, 6);
    const decoded = decodePolyline(encoded, 6);
    for (let i = 0; i < route.length; i += 1) {
      expect(decoded[i][0]).toBeCloseTo(route[i][0], 6);
      expect(decoded[i][1]).toBeCloseTo(route[i][1], 6);
    }
  });

  it("round-trips a single-point line and an empty line", () => {
    expect(decodePolyline(encodePolyline([]))).toEqual([]);
    const [pt] = decodePolyline(encodePolyline([[-104.9903, 39.7392]]));
    expect(pt[0]).toBeCloseTo(-104.9903, 5);
    expect(pt[1]).toBeCloseTo(39.7392, 5);
  });

  it("handles a coordinate that crosses zero in both directions", () => {
    const route: LngLatCoord[] = [
      [0.00002, 0.00002],
      [-0.00003, -0.00001],
      [0.00001, -0.00004],
    ];
    const decoded = decodePolyline(encodePolyline(route));
    for (let i = 0; i < route.length; i += 1) {
      expect(decoded[i][0]).toBeCloseTo(route[i][0], 5);
      expect(decoded[i][1]).toBeCloseTo(route[i][1], 5);
    }
  });
});

describe("encodePolyline — input validation", () => {
  it("throws RangeError on a non-finite coordinate rather than emitting a corrupt string", () => {
    expect(() => encodePolyline([[NaN, 39.7392]])).toThrow(RangeError);
    expect(() => encodePolyline([[-104.9903, Infinity]])).toThrow(RangeError);
    expect(() => encodePolyline([[-Infinity, 39.7392]])).toThrow(RangeError);
  });
});
