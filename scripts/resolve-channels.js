#!/usr/bin/env node

/**
 * resolve-channels.js
 * 
 * One-time setup script that resolves YouTube @handle URLs to channel IDs.
 * Scrapes each channel page for the canonical channel ID (UC...) and writes
 * it back into creators.json as metadata.
 * 
 * Usage: node scripts/resolve-channels.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREATORS_PATH = resolve(__dirname, '..', 'creators.json');

/**
 * Fetches a YouTube channel page and extracts the channel ID.
 * Looks for the canonical channel URL or the channelId in the page source.
 * 
 * @param {string} url - The YouTube channel URL (e.g., https://www.youtube.com/@NicoLeonard)
 * @returns {Promise<string|null>} The channel ID (UC...) or null if not found
 */
async function resolveChannelId(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      console.error(`  ✗ HTTP ${response.status} for ${url}`);
      return null;
    }

    const html = await response.text();

    // Method 1: Look for canonical channel URL
    // <link rel="canonical" href="https://www.youtube.com/channel/UCxxxxxxxx">
    const canonicalMatch = html.match(/href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)"/);
    if (canonicalMatch) {
      return canonicalMatch[1];
    }

    // Method 2: Look for channelId in page metadata
    // "channelId":"UCxxxxxxxx"
    const metaMatch = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/);
    if (metaMatch) {
      return metaMatch[1];
    }

    // Method 3: Look for browse_id
    // "browseId":"UCxxxxxxxx"
    const browseMatch = html.match(/"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/);
    if (browseMatch) {
      return browseMatch[1];
    }

    console.error(`  ✗ Could not find channel ID in page source for ${url}`);
    return null;
  } catch (error) {
    console.error(`  ✗ Error fetching ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Builds the YouTube RSS feed URL from a channel ID.
 * @param {string} channelId 
 * @returns {string}
 */
function buildFeedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

async function main() {
  console.log('🔍 Resolving YouTube channel IDs...\n');

  const creators = JSON.parse(readFileSync(CREATORS_PATH, 'utf-8'));
  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const creator of creators) {
    process.stdout.write(`  ${creator.channel_name}... `);

    // Skip if already resolved
    if (creator.channel_id) {
      console.log(`✓ already resolved (${creator.channel_id})`);
      skipped++;
      continue;
    }

    const channelId = await resolveChannelId(creator.url);

    if (channelId) {
      creator.channel_id = channelId;
      creator.feed_url = buildFeedUrl(channelId);
      console.log(`✓ ${channelId}`);
      resolved++;
    } else {
      failed++;
    }

    // Be polite — don't hammer YouTube
    await new Promise(r => setTimeout(r, 1000));
  }

  // Write updated creators back to file
  writeFileSync(CREATORS_PATH, JSON.stringify(creators, null, 2) + '\n', 'utf-8');

  console.log(`\n📊 Results:`);
  console.log(`   Resolved: ${resolved}`);
  console.log(`   Skipped:  ${skipped}`);
  console.log(`   Failed:   ${failed}`);
  console.log(`\n✅ Updated ${CREATORS_PATH}`);
}

main().catch(console.error);
