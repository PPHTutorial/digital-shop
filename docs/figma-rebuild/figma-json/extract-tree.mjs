#!/usr/bin/env node
/**
 * Flattens a saved Figma node JSON (one of the files in this directory)
 * into an indented, human-readable tree: type, name, size, position
 * (relative to the frame's own origin), fill/stroke color, corner radius,
 * auto-layout mode/gap/padding, and — for TEXT nodes — font family/size/
 * weight/color and the first ~90 characters.
 *
 * Usage:
 *   node docs/figma-rebuild/figma-json/extract-tree.mjs \
 *     docs/figma-rebuild/figma-json/<screen>.json <node-id>
 *
 * <node-id> is the top-level frame id embedded in the filename (e.g.
 * "3:8" for homepage-3-8.json) — every file here holds exactly one frame,
 * so this is just `data.nodes[nodeId].document`.
 *
 * Prints to stdout; redirect to a file if you want to keep it.
 */
import fs from 'fs';

const [, , inPath, rootId] = process.argv;
if (!inPath || !rootId) {
  console.error('Usage: node extract-tree.mjs <path-to-json> <node-id>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const entry = data.nodes[rootId];
if (!entry) {
  console.error(`Node ${rootId} not found in ${inPath}. Available: ${Object.keys(data.nodes).join(', ')}`);
  process.exit(1);
}
const root = entry.document;
const originX = root.absoluteBoundingBox.x;
const originY = root.absoluteBoundingBox.y;

function hex(c) {
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  const a = c.a !== undefined ? c.a : 1;
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return a < 1 ? `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(Math.round(a * 255))}` : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function fillsOf(node) {
  const fills = (node.fills || []).filter((f) => f.visible !== false);
  if (!fills.length) return '';
  return fills.map((f) => {
    if (f.type === 'SOLID') return hex({ ...f.color, a: f.opacity ?? f.color.a });
    if (f.type?.startsWith('GRADIENT')) return f.type;
    if (f.type === 'IMAGE') return 'IMAGE';
    return f.type;
  }).join(',');
}

function lines(node, depth, out) {
  const pad = '  '.repeat(depth);
  const box = node.absoluteBoundingBox || {};
  const x = box.x !== undefined ? Math.round(box.x - originX) : '?';
  const y = box.y !== undefined ? Math.round(box.y - originY) : '?';
  const w = box.width !== undefined ? Math.round(box.width) : '?';
  const h = box.height !== undefined ? Math.round(box.height) : '?';
  let attrs = `${node.type} "${node.name}" @${x},${y} ${w}x${h}`;

  if (node.type === 'TEXT') {
    const style = node.style || {};
    const chars = (node.characters || '').replace(/\n/g, '\\n');
    const color = fillsOf(node);
    attrs += ` font="${style.fontFamily}" size=${style.fontSize} weight=${style.fontWeight} lh=${style.lineHeightPx ? Math.round(style.lineHeightPx) : ''} color=${color} text="${chars.slice(0, 90)}"`;
  } else {
    const fill = fillsOf(node);
    if (fill) attrs += ` fill=${fill}`;
    if (node.cornerRadius) attrs += ` radius=${node.cornerRadius}`;
    if (node.strokes?.length) attrs += ` stroke=${fillsOf({ fills: node.strokes })}`;
    if (node.layoutMode) {
      attrs += ` layout=${node.layoutMode} gap=${node.itemSpacing || 0} pad=${node.paddingTop || 0}/${node.paddingRight || 0}/${node.paddingBottom || 0}/${node.paddingLeft || 0}`;
      if (node.primaryAxisAlignItems) attrs += ` primary=${node.primaryAxisAlignItems}`;
      if (node.counterAxisAlignItems) attrs += ` counter=${node.counterAxisAlignItems}`;
    }
    if (node.layoutGrow) attrs += ` grow=${node.layoutGrow}`;
  }
  out.push(pad + attrs);
  for (const child of node.children || []) lines(child, depth + 1, out);
}

const out = [];
lines(root, 0, out);
console.log(out.join('\n'));
