#!/usr/bin/env node

/**
 * fetch-avatars.js
 *
 * One-time setup script that resolves each creator's YouTube channel avatar
 * and writes it back into creators.json as an `avatar` field. Scrapes the
 * channel page's Open Graph image (`<meta property="og:image">`), which is the
 * channel's profile picture — no API key required.
 *
 * The Channels tab renders these; a card falls back to a monogram tile when a
 * creator has no `avatar` (or the image fails to load), so a missing one is a
 * soft failure, not a broken card.
 *
 * Usage:
 *   node scripts/fetch-avatars.js           # fill in missing avatars only
 *   node scripts/fetch-avatars.js --force   # re-fetch every avatar
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREATORS_PATH = resolve(__dirname, '..', 'creators.json');
const FORCE = process.argv.includes('--force');

/**
 * Fetches a YouTube channel page and extracts the profile-picture URL from its
 * Open Graph image tag. Prefers the channel_id URL (canonical) and falls back
 * to the stored @handle url.
 *
 * @param {{channel_id?: string, url?: string}} creator
 * @returns {Promise<string|null>} The avatar URL, or null if not found
 */
async function fetchAvatar(creator) {
  const pageUrl = creator.channel_id
    ? `https://www.youtube.com/channel/${creator.channel_id}`
    : creator.url;
  if (!pageUrl) return null;

  try {
    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      console.error(`  ✗ HTTP ${response.status} for ${pageUrl}`);
      return null;
    }

    const html = await response.text();

    // <meta property="og:image" content="https://yt3.googleusercontent.com/...">
    const ogMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (ogMatch && ogMatch[1].includes('googleusercontent.com')) {
      return ogMatch[1];
    }

    console.error(`  ✗ No og:image avatar found for ${pageUrl}`);
    return null;
  } catch (error) {
    console.error(`  ✗ Error fetching ${pageUrl}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🖼  Fetching YouTube channel avatars...\n');

  const creators = JSON.parse(readFileSync(CREATORS_PATH, 'utf-8'));
  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  for (const creator of creators) {
    process.stdout.write(`  ${creator.channel_name}... `);

    if (creator.avatar && !FORCE) {
      console.log('✓ already has avatar');
      skipped++;
      continue;
    }

    const avatar = await fetchAvatar(creator);

    if (avatar) {
      creator.avatar = avatar;
      console.log('✓');
      fetched++;
    } else {
      failed++;
    }

    // Be polite — don't hammer YouTube
    await new Promise(r => setTimeout(r, 1000));
  }

  writeFileSync(CREATORS_PATH, JSON.stringify(creators, null, 2) + '\n', 'utf-8');

  console.log(`\n📊 Results:`);
  console.log(`   Fetched: ${fetched}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Failed:  ${failed}`);
  console.log(`\n✅ Updated ${CREATORS_PATH}`);
}

main().catch(console.error);
