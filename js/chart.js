/**
 * Charts.
 *
 * Plain SVG strings, no library, no canvas. Colour, stroke, and type come from
 * the CSS in `05-components.css`, so charts follow the theme automatically and
 * print correctly.
 */

import { esc } from './dom.js';
import { formatCompact, formatDate } from './format.js';

const PAD = { top: 8, right: 8, bottom: 22, left: 44 };

function scale(value, min, max, size) {
  if (max === min) return size / 2;
  return ((value - min) / (max - min)) * size;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].find((multiple) => multiple * magnitude >= rough) * magnitude;
  const ticks = [];
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(value);
  return ticks;
}

/**
 * Line chart with an optional filled area.
 *
 * @param {Array<{label: string, value: number}>} points
 */
export function lineChart(points, { height = 200, format = formatCompact, accent = false } = {}) {
  if (!points?.length) return emptyChart(height);

  const width = 640; // viewBox units; the SVG scales to its container
  const innerWidth = width - PAD.left - PAD.right;
  const innerHeight = height - PAD.top - PAD.bottom;

  const values = points.map((point) => Number(point.value) || 0);
  const max = Math.max(...values, 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];

  const x = (index) => PAD.left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value) => PAD.top + innerHeight - scale(value, 0, top, innerHeight);

  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join('');
  const area = `${path}L${x(points.length - 1).toFixed(1)},${(PAD.top + innerHeight).toFixed(1)}L${x(0).toFixed(1)},${(PAD.top + innerHeight).toFixed(1)}Z`;

  const labelEvery = Math.max(1, Math.ceil(points.length / 7));

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="none"
         aria-label="Line chart of ${points.length} points">
      ${ticks
        .map(
          (tick) => `
            <line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"/>
            <text class="tick" x="${PAD.left - 8}" y="${(y(tick) + 3).toFixed(1)}" text-anchor="end">${esc(format(tick))}</text>
          `,
        )
        .join('')}
      <path class="series-area" d="${area}"/>
      <path class="series-line${accent ? ' series-line--accent' : ''}" d="${path}"/>
      ${points
        .map((point, index) =>
          index % labelEvery === 0 || index === points.length - 1
            ? `<text class="tick" x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(point.label)}</text>`
            : '',
        )
        .join('')}
      ${points.length <= 32
        ? points
            .map((point, index) => `<circle class="point" cx="${x(index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="2.5"><title>${esc(`${point.label}: ${format(point.value)}`)}</title></circle>`)
            .join('')
        : ''}
    </svg>
  `;
}

/**
 * Vertical bar chart.
 *
 * @param {Array<{label: string, value: number}>} bars
 */
export function barChart(bars, { height = 200, format = formatCompact, accent = false } = {}) {
  if (!bars?.length) return emptyChart(height);

  const width = 640;
  const innerWidth = width - PAD.left - PAD.right;
  const innerHeight = height - PAD.top - PAD.bottom;

  const max = Math.max(...bars.map((bar) => Number(bar.value) || 0), 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];

  const slot = innerWidth / bars.length;
  const barWidth = Math.max(3, Math.min(38, slot * 0.62));

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="none"
         aria-label="Bar chart of ${bars.length} values">
      ${ticks
        .map(
          (tick) => `
            <line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}"
                  y1="${(PAD.top + innerHeight - scale(tick, 0, top, innerHeight)).toFixed(1)}"
                  y2="${(PAD.top + innerHeight - scale(tick, 0, top, innerHeight)).toFixed(1)}"/>
            <text class="tick" x="${PAD.left - 8}"
                  y="${(PAD.top + innerHeight - scale(tick, 0, top, innerHeight) + 3).toFixed(1)}"
                  text-anchor="end">${esc(format(tick))}</text>
          `,
        )
        .join('')}
      ${bars
        .map((bar, index) => {
          const barHeight = scale(Number(bar.value) || 0, 0, top, innerHeight);
          const x = PAD.left + slot * index + (slot - barWidth) / 2;
          const y = PAD.top + innerHeight - barHeight;
          return `
            <rect class="series-bar${accent ? ' series-bar--accent' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
                  width="${barWidth.toFixed(1)}" height="${Math.max(1, barHeight).toFixed(1)}" rx="1">
              <title>${esc(`${bar.label}: ${format(bar.value)}`)}</title>
            </rect>
            ${bars.length <= 14 ? `<text class="tick" x="${(x + barWidth / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(bar.label)}</text>` : ''}
          `;
        })
        .join('')}
      <line class="axis" x1="${PAD.left}" x2="${width - PAD.right}" y1="${PAD.top + innerHeight}" y2="${PAD.top + innerHeight}"/>
    </svg>
  `;
}

/** A compact inline trend line with no axes, for table cells and tiles. */
export function sparkline(values, { width = 120, height = 28 } = {}) {
  if (!values?.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const step = values.length === 1 ? width : width / (values.length - 1);
  const path = values
    .map((value, index) => {
      const x = index * step;
      const y = height - scale(value, min, max, height - 2) - 1;
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path class="series-line" d="${path}"/></svg>`;
}

/** Horizontal ranking meters — clearer than a pie for share-of-total. */
export function meterList(items, { format = formatCompact, accent = false } = {}) {
  if (!items?.length) return '<p class="t-13 subtle">No data for this period.</p>';
  const max = Math.max(...items.map((item) => Number(item.value) || 0), 1);

  return `<div class="meter">${items
    .map(
      (item) => `
        <div>
          <div class="meter__row">
            <span class="meter__name">${esc(item.label)}</span>
            <span class="meter__value">${esc(format(item.value))}</span>
          </div>
          <div class="meter__track">
            <div class="meter__fill${accent ? ' meter__fill--accent' : ''}"
                 style="width:${((Number(item.value) || 0) / max * 100).toFixed(1)}%"></div>
          </div>
        </div>
      `,
    )
    .join('')}</div>`;
}

function emptyChart(height) {
  return `
    <div class="empty" style="min-height:${height}px;padding:var(--s-6)">
      <p class="empty__body">Not enough data to chart yet.</p>
    </div>
  `;
}

/** Turns a `{date, value}` series into chart points with short day labels. */
export function toDailyPoints(series, key = 'revenue') {
  return (series || []).map((entry) => ({
    label: formatDate(entry.date, 'dayMonth'),
    value: Number(entry[key]) || 0,
  }));
}
