// export.js — SVG, CSV, and print-to-PDF export.

import { state } from './state.js';
import { getCanvas } from './render.js';
import { summarise } from './calc.js';

export function exportSVG() {
  const src = getCanvas();
  if (!src) return;
  const clone = src.cloneNode(true);
  // Inline computed attributes so the SVG renders standalone.
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Embed CSS rules so colours survive outside the page.
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = embeddedCSS();
  clone.insertBefore(styleEl, clone.firstChild);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  download(blob, fileBase() + '.svg');
}

export function exportCSV() {
  const rows = [
    ['Loop', 'Room', 'Group', 'Pipe (m)', 'Tail (m)', 'Total (m)', 'Pattern', 'Colour'],
  ];
  const colourNames = ['red', 'blue', 'green', 'cyan'];
  for (const l of state.loops) {
    const room = state.rooms.find(r => r.id === l.roomId);
    rows.push([
      l.label,
      l.roomName,
      `Group ${l.group}`,
      (l.pipeLength / 1000).toFixed(1),
      (l.tailLength / 1000).toFixed(1),
      (l.totalLength / 1000).toFixed(1),
      room ? room.pattern : '',
      colourNames[l.colour] || String(l.colour),
    ]);
  }
  const sum = summarise(state);
  rows.push([]);
  rows.push(['Totals']);
  rows.push(['Floor area (m²)', sum.totalArea.toFixed(1)]);
  rows.push(['Total pipe (m)', sum.totalPipe.toFixed(1)]);
  rows.push(['Order qty incl. wastage (m)', sum.orderQty.toFixed(1)]);
  rows.push(['Loops', sum.loopCount]);
  rows.push(['Manifold ports required', sum.portsRequired]);
  rows.push(['Loop length min/max (m)', `${sum.minLen.toFixed(1)} / ${sum.maxLen.toFixed(1)}`]);
  rows.push(['Spread (%)', sum.spread.toFixed(1)]);

  const csv = rows.map(r => r.map(csvEsc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  download(blob, fileBase() + '.csv');
}

export function printDrawing() {
  const src = getCanvas();
  if (!src) return;
  const svgString = new XMLSerializer().serializeToString(src);
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${escapeHtml(state.project.title)} — UFH Layout</title>
    <style>
      @page { size: A3 landscape; margin: 10mm; }
      html, body { margin: 0; padding: 0; }
      body { font: 12px sans-serif; }
      .wrap { width: 100%; height: 100vh; }
      svg { width: 100%; height: 100%; }
      ${embeddedCSS()}
    </style></head><body>
    <div class="wrap">${svgString}</div>
    <script>setTimeout(() => window.print(), 200);</script>
    </body></html>`);
  w.document.close();
}

function fileBase() {
  const safe = (state.project.title || 'ufh').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  return `${safe}-${state.project.date}`;
}

function csvEsc(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Subset of styles needed inside an exported / printed SVG.
function embeddedCSS() {
  return `
    .room-rect { fill: #fafbfc; stroke: #b4bcc8; stroke-width: 30; }
    .room-rect.selected { stroke: #1d6fc4; }
    .wall.external { stroke: #2c3340; stroke-width: 80; }
    .wall.internal { stroke: #6b7587; stroke-width: 50; }
    .room-label { font-weight: 700; text-anchor: middle; fill: #6b7587; }
    .room-area { text-anchor: middle; fill: #99a2b1; }
    .nogo { fill: rgba(196, 38, 46, 0.10); stroke: #c4262e; stroke-width: 20; stroke-dasharray: 80 60; }
    .nogo-label { text-anchor: middle; fill: #c4262e; }
    .manifold { fill: #f9e6e7; stroke: #c4262e; stroke-width: 50; }
    .manifold-label { fill: #c4262e; font-weight: 700; text-anchor: middle; }
    .pipe { fill: none; stroke-width: 22; stroke-linecap: round; stroke-linejoin: round; }
    .pipe-tail { fill: none; stroke-width: 22; stroke-linecap: round; opacity: 0.85; }
    .pipe.c0, .pipe-tail.c0 { stroke: #c4262e; }
    .pipe.c1, .pipe-tail.c1 { stroke: #1d6fc4; }
    .pipe.c2, .pipe-tail.c2 { stroke: #2e8c4f; }
    .pipe.c3, .pipe-tail.c3 { stroke: #2aaab4; }
    .loop-label { fill: #1d2330; font-weight: 600; text-anchor: middle; }
    .loop-label-bg { fill: white; stroke: #1d2330; stroke-width: 8; }
    .title-block { fill: white; stroke: #1d2330; stroke-width: 30; }
    .title-block-text { fill: #1d2330; font-family: -apple-system, sans-serif; }
  `;
}
