/**
 * Setup.gs — One-time setup functions for WatchDirectly
 * 
 * ⚠️  ARCHIVE: This file is retained for reference only.
 *     The spreadsheet IDs here MUST match SPREADSHEET_IDS in Code.gs.
 *     Do NOT run these functions unless re-initializing from scratch.
 * 
 * Run these manually from the Apps Script editor:
 *   1. Select function from dropdown → populateChannels → Run
 *   2. Select function from dropdown → populateMeta → Run
 *
 * populateChannelAvatars is NOT archival — run it once after deploying the
 * getChannels backend action, to backfill the CHANNELS sheet's avatar column
 * (migrated from the now-deleted creators.json).
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
  ];

  // Write all rows at once (fast)
  var range = sheet.getRange(2, 1, creators.length, creators[0].length);
  range.setValues(creators);

  Logger.log('✅ Populated ' + creators.length + ' channels');
}

// One-time backfill: adds the 'avatar' column to the CHANNELS sheet and
// populates it by matching channel_name, migrating the data that used to
// live in the frontend's creators.json (now removed — handleGetChannels in
// Code.gs serves this sheet directly).
function populateChannelAvatars() {
  var sheet = SpreadsheetApp.openById('1P6m12rLNOVej8QgMwOJdREliOAhM6oyEHD7JCC6iRPo').getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var nameCol = headers.indexOf('channel_name');

  var avatarCol = headers.indexOf('avatar');
  if (avatarCol === -1) {
    avatarCol = headers.length;
    sheet.getRange(1, avatarCol + 1).setValue('avatar');
  }

  var avatarsByName = {
    'Nico Leonard': 'https://yt3.googleusercontent.com/ytc/AIdro_nYWjPDi0RrrxqVvI8EFXDoFNQETCMs7YzGWD2sxQPt_oo=s900-c-k-c0x00ffffff-no-rj',
    'Producer Michael': 'https://yt3.googleusercontent.com/ytc/AIdro_mMksz85osapErevmr_MtauIgeA80ADzsUJOhnCCJL1f-E=s900-c-k-c0x00ffffff-no-rj',
    'Teddy Baldassarre': 'https://yt3.googleusercontent.com/ytc/AIdro_mF_7CCbBfQFNo3jGFHaO4mAAOfD0mPe09I6jMnhZI_Z8A=s900-c-k-c0x00ffffff-no-rj',
    'Watchfinder & Co.': 'https://yt3.googleusercontent.com/F3FBTBYJkWdP5Kuco7MMlwDbvLoEgT_4ddXfuw8NO9dnb4RxLs21XweU_OAPhM2Ne0gfDNuOBA=s900-c-k-c0x00ffffff-no-rj',
    'The Urban Gentry': 'https://yt3.googleusercontent.com/ytc/AIdro_nZ-7lTQnj-HhWado5F-TAckMr7Q9BUPDznJFILINGYdDY=s900-c-k-c0x00ffffff-no-rj',
    'Roman Sharf (Luxury Bazaar)': 'https://yt3.googleusercontent.com/ytc/AIdro_lWNPyGwqddfd0AWp0tetGpuhplsn4aiH5lR5QXf1jI2gMS=s900-c-k-c0x00ffffff-no-rj',
    'Hodinkee': 'https://yt3.googleusercontent.com/KDwrbI8TcMOi3b2--HyE0-zNX7VkfwlScwLMjzadNV0dGs2BuyEdBuR8nvwqrC4uVSXNGBPu=s900-c-k-c0x00ffffff-no-rj',
    'Just One More Watch': 'https://yt3.googleusercontent.com/ytc/AIdro_kiq8B08cBi7VV18nlxERihluQRd9NkjkjVu_xsyyxCzA=s900-c-k-c0x00ffffff-no-rj',
    'Jenni Elle': 'https://yt3.googleusercontent.com/ytc/AIdro_nzZ9QGYtliBgjbPPWS88hAcNP0DbNvGGmWLgcqfDEb7g=s900-c-k-c0x00ffffff-no-rj',
    'Bark and Jack': 'https://yt3.googleusercontent.com/rtXmhUGI9YJrCwJNMMXUeAlR9X43zG6I1i11yd2G34K0uohfcM9h4k-gjkJ8XEi2WptGzs4qpw=s900-c-k-c0x00ffffff-no-rj',
    "Ben's Watch Club": 'https://yt3.googleusercontent.com/oqUcbGXRZKSkx6us7N8RhA308-w1J-VY5_HrOmFP3WEReOPCwZ1nY39d5AlQITjzBYAt9Z4crA=s900-c-k-c0x00ffffff-no-rj',
    'Federico Talks Watches': 'https://yt3.googleusercontent.com/ytc/AIdro_mmmwF_Ozpe6gRFgmAaJKNfxj6RqFEicvTstgrNf0VRgTQ=s900-c-k-c0x00ffffff-no-rj',
    'The Time Teller': 'https://yt3.googleusercontent.com/ytc/AIdro_mB9bkNZDfKStQZ_M1InKPXRwO0rItzp9hRvr_8YBdgwEQ=s900-c-k-c0x00ffffff-no-rj',
    'Long Island Watch': 'https://yt3.googleusercontent.com/PMFSobF-HIiYkpWtH04iC8NTCRbZb89cWLMiw_UgzTb8ynsmgY6t7_zbQqLJzyWq_r9kpACIpRU=s900-c-k-c0x00ffffff-no-rj',
    'YoureTerrific': 'https://yt3.googleusercontent.com/AbeCLKiinoYW97vfO30rWyV1av7aRn4ik0vcuFBuEURCV8VlKch2wN_TQ-qTRYhWS6r-Fd92Xg=s900-c-k-c0x00ffffff-no-rj',
    'The 1916 Company (formerly WatchBox)': 'https://yt3.googleusercontent.com/LxJ6Nys_GeZq8CKBw8v2BPIHpBfib_jzOlFNofRlLTaZnNmmb717YJa_4wSvJcQF-gPKAfOqyQ=s900-c-k-c0x00ffffff-no-rj',
    'Andrew Morgan Watches': 'https://yt3.googleusercontent.com/5cjUA-Uo3J8DxQaKzRVNf9Z35oQIp2wrtEQCKnYn7otzHDW7lvtMZ3kmGrxJTGM0XXW51ywAGb8=s900-c-k-c0x00ffffff-no-rj',
    'Archieluxury': 'https://yt3.googleusercontent.com/ytc/AIdro_k9popVl8y9Q-Ki0vCbvSBPBXv0pa40rfet5AtuSTuhCyQ=s900-c-k-c0x00ffffff-no-rj',
  };

  var updated = 0;
  for (var i = 1; i < data.length; i++) {
    var avatar = avatarsByName[data[i][nameCol]];
    if (avatar) {
      sheet.getRange(i + 1, avatarCol + 1).setValue(avatar);
      updated++;
    }
  }

  Logger.log('✅ Set avatar for ' + updated + ' channels');
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
