// calc.js — derive headline figures from generated loops.

import { polygonArea } from './geometry.js';

export function summarise(state) {
  const { rooms, loops, config } = state;
  const totalArea = rooms.reduce((acc, r) => acc + polygonArea(r.vertices || []) / 1e6, 0); // m²
  const totalPipe = loops.reduce((acc, l) => acc + l.totalLength, 0) / 1000; // m
  const tails = loops.reduce((acc, l) => acc + l.tailLength, 0) / 1000;
  const wastage = totalPipe * (config.wastageFactor - 1);
  const orderQty = totalPipe + wastage;

  let minLen = Infinity, maxLen = -Infinity;
  for (const l of loops) {
    const m = l.totalLength / 1000;
    if (m < minLen) minLen = m;
    if (m > maxLen) maxLen = m;
  }
  const spread = loops.length ? ((maxLen - minLen) / Math.max(maxLen, 1)) * 100 : 0;

  // Rough heat output estimate. Tile floor at 200 mm spacing with 45 °C flow
  // gives roughly 70 W/m² in the field zone. Scale linearly with spacing as a
  // first approximation. Edge zones run hotter so the average comes out higher.
  const baselineW = 70;
  const spacingFactor = 200 / Math.max(80, config.pipeSpacing);
  const estimatedOutput = baselineW * spacingFactor;

  return {
    totalArea,
    totalPipe,
    tails,
    wastage,
    orderQty,
    loopCount: loops.length,
    portsRequired: loops.length, // each loop uses one flow + one return port (one "way")
    minLen: loops.length ? minLen : 0,
    maxLen: loops.length ? maxLen : 0,
    spread,
    estimatedOutput,
  };
}
