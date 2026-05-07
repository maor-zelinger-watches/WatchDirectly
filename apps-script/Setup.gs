/**
 * Setup.gs — One-time setup functions for WatchDirectly
 * 
 * Run these manually from the Apps Script editor:
 *   1. Select function from dropdown → populateChannels → Run
 *   2. Select function from dropdown → populateMeta → Run
 * 
 * Delete this file after setup is complete.
 */

function populateChannels() {
  var sheet = SpreadsheetApp.openById('1P6m12rLNOVej8QgMwOJdREliOAhM6oyEHD7JCC6iRPo').getSheets()[0];
  
  var creators = [
    ['Nico Leonard', 'Nico Leonard', 0, 'The Heavyweights & Entertainment', 'Grey market dealing, reaction videos, celebrity collections', 'https://www.youtube.com/@NicoLeonard', 'UCXPXfAAo-yV6Y-0PZecwBLw', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXPXfAAo-yV6Y-0PZecwBLw', true],
    ['Producer Michael', 'Michael Blakey', 0, 'The Heavyweights & Entertainment', 'Ultra high-end luxury lifestyle, diamond-encrusted pieces', 'https://www.youtube.com/@producermichael', 'UCP0ok1nSEenuz-e_ulNAJjg', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCP0ok1nSEenuz-e_ulNAJjg', true],
    ['Teddy Baldassarre', 'Teddy Baldassarre', 0, 'The Heavyweights & Entertainment', 'Polished reviews, buying guides, brand CEO interviews', 'https://www.youtube.com/@TeddyBaldassarre', 'UCLGp7H4XuzA9TLJ0L4PUx8w', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCLGp7H4XuzA9TLJ0L4PUx8w', true],
    ['Watchfinder & Co.', 'Various', 0, 'Cinematography & High-End Masters', 'Horological education, luxury pre-owned, macro-videography', 'https://www.youtube.com/@watchfinder', 'UCLaoR2K7Dsa_KUK-DVpdZZA', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCLaoR2K7Dsa_KUK-DVpdZZA', true],
    ['The Urban Gentry', 'Tristano Veneto (TGV)', 1, 'The Enthusiast & Lifestyle Favorites', 'Affordable to luxury, horological history, menswear', 'https://www.youtube.com/@theurbangentry', 'UC0ulDfOIUVoZAhHPuCTiawg', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0ulDfOIUVoZAhHPuCTiawg', true],
    ['Roman Sharf (Luxury Bazaar)', 'Roman Sharf', 1, 'The Industry Insiders & Grey Market Dealers', 'Behind-the-scenes grey market dealing, wholesale trading', 'https://www.youtube.com/@RomanSharf', 'UCoPXAn8QnYeVLvcW8z9LDmQ', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCoPXAn8QnYeVLvcW8z9LDmQ', true],
    ['Hodinkee', 'Various', 1, 'Cinematography & High-End Masters', 'Watch media journalism, Talking Watches series', 'https://www.youtube.com/@hodinkee', 'UCZnVGL3UzxeC1LMrJGcI0Cg', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCZnVGL3UzxeC1LMrJGcI0Cg', true],
    ['Just One More Watch', 'Jody Musgrove', 1, 'The Affordable & "Value" Kings', 'Budget watches, microbrands, Seikos, Casios', 'https://www.youtube.com/@JustOneMoreWatch', 'UCzllztCuniR_83Fwuz70xcg', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCzllztCuniR_83Fwuz70xcg', true],
    ['Jenni Elle', 'Jenni Elle', 1, 'The Enthusiast & Lifestyle Favorites', 'Structured reviews, accessible explanations, sizing guides', 'https://www.youtube.com/@JenniElle', 'UC4TLvsSDZQb-TBrhDID3jPg', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC4TLvsSDZQb-TBrhDID3jPg', true],
    ['Bark and Jack', 'Adrian Barker', 1, 'The Enthusiast & Lifestyle Favorites', 'Sports watches, grey market trends, ownership experiences', 'https://www.youtube.com/@BarkandJack', 'UCvIIb5YF8sUnm1D62jCvVVw', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvIIb5YF8sUnm1D62jCvVVw', true],
    ["Ben's Watch Club", 'Ben Arthur', 2, 'The Affordable & "Value" Kings', 'Affordable watches, beginner advice, value-for-money', 'https://www.youtube.com/@BensWatchClub', 'UC4zt4qDcBH5OcSRth5PbZqw', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC4zt4qDcBH5OcSRth5PbZqw', true],
    ['Federico Talks Watches', 'Federico Ienner', 2, 'The Industry Insiders & Grey Market Dealers', 'Watch values, brand prestige, market insights', 'https://www.youtube.com/@FedericoTalksWatches', 'UCH27JDu8g6tPDIjDikVGPog', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCH27JDu8g6tPDIjDikVGPog', true],
    ['The Time Teller', 'Jory Goodman', 2, 'The Enthusiast & Lifestyle Favorites', 'High-energy reviews, budget vintage, community streams', 'https://www.youtube.com/@thetimeteller', 'UCugWBGRcE8hx8ve527uHcfw', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCugWBGRcE8hx8ve527uHcfw', true],
    ['Long Island Watch', 'Marc Frankel', 2, 'The Industry Insiders & Retailers', 'Retailer insights, educational series, Seiko modding', 'https://www.youtube.com/@islandwatch', 'UCSEvXHaDCfaWRi0Nulu7Efw', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCSEvXHaDCfaWRi0Nulu7Efw', true],
    ['YoureTerrific', 'Evan', 2, 'The Enthusiast & Lifestyle Favorites', 'Dry humor, cinematic b-roll, real-world wearing experience', 'https://www.youtube.com/@YoureTerrific', 'UCRImyW2li9K4tZvSmhFAOuQ', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCRImyW2li9K4tZvSmhFAOuQ', true],
    ['The 1916 Company (formerly WatchBox)', 'Tim Mosso', 2, 'Cinematography & High-End Masters', 'Encyclopedic technical knowledge, movement calibers', 'https://www.youtube.com/@the1916company', 'UCpn6IctAyZPk1QoHUAAJUnQ', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCpn6IctAyZPk1QoHUAAJUnQ', true],
    ['Andrew Morgan Watches', 'Andrew Morgan', 2, 'The Enthusiast & Lifestyle Favorites', 'Dry British humor, industry critiques, brand reviews', 'https://www.youtube.com/@AndrewMorganWatches', 'UCOu5VKZIHDXS-cHn9TOC0Qg', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCOu5VKZIHDXS-cHn9TOC0Qg', true],
    ['Archieluxury', 'Paul Pluta', 3, 'Cult Classics & Niche', 'OG of WatchTube, comedic rants, strict luxury focus', 'https://www.youtube.com/@ARCHIELUXURY', 'UCQ0qP6koCeknuEjb11DjX_Q', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCQ0qP6koCeknuEjb11DjX_Q', true],
    ['Britt Pearce', 'Britt Pearce', 3, 'Cult Classics & Niche', 'Female collector perspective, luxury sports watches', 'https://www.youtube.com/@BrittPearce', 'UCmIgKme9v1XtUahrVX3_QrA', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCmIgKme9v1XtUahrVX3_QrA', true],
  ];

  // Write all rows at once (fast)
  var range = sheet.getRange(2, 1, creators.length, creators[0].length);
  range.setValues(creators);

  Logger.log('✅ Populated ' + creators.length + ' channels');
}

function populateMeta() {
  var sheet = SpreadsheetApp.openById('11Zm0nouToxUzXQZZ4OQOcYcFLl0xdSsWQfPLsQs0AF4').getSheets()[0];
  
  var rows = [
    ['refresh_interval_hours', '4'],
    ['site_name', 'WatchDirectly'],
    ['log_level', 'ERROR'],
  ];

  var range = sheet.getRange(2, 1, rows.length, 2);
  range.setValues(rows);

  Logger.log('✅ Populated Meta with ' + rows.length + ' config entries');
}
