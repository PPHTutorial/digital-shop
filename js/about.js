/**
 * About page.
 *
 * Content is editorial and lives in the CMS (`cms_documents`, type `page`,
 * slug `about`) so it can be changed from the studio without a deploy. Falls
 * back to fixed copy if the document has not been published yet.
 */

import { supabase } from './client.js';
import { $ } from './dom.js';
import { renderBlocks } from './portable-text.js';
import { initTheme, mountHeader, mountFooter, bootDone, initReveal } from './ui.js';

initTheme();
mountHeader();
mountFooter();

const FALLBACK = {
  title: 'About DigiStore',
  lede: 'DigiStore is the storefront Codeink Technologies uses to sell the things it builds — and a small, carefully chosen set of work by people we trust.',
  body: [],
};

async function loadAbout() {
  const { data } = await supabase
    .from('cms_documents')
    .select('title,published')
    .eq('type', 'page')
    .eq('slug', 'about')
    .not('published', 'is', null)
    .maybeSingle();
  return data?.published ? { title: data.title || FALLBACK.title, ...data.published } : FALLBACK;
}

function paint(doc) {
  $('#about-title').textContent = doc.title || FALLBACK.title;
  $('#about-lede').textContent = doc.lede || FALLBACK.lede;
  $('#about-body').innerHTML = renderBlocks(doc.body || []);
}

async function run() {
  try {
    paint(await loadAbout());
  } catch {
    paint(FALLBACK);
  }
  bootDone();
  initReveal();
}

run();
