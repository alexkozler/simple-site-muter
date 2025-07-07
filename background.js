// Storage key for muted domains
const MUTED_DOMAINS_KEY = 'mutedDomains';

// Logging helper
function log(message, error = null) {
  if (error) {
    console.error(`[Site Muter] ${message}`, error);
  } else {
    console.log(`[Site Muter] ${message}`);
  }
}

// Extract domain from URL with error handling
function getDomain(url) {
  try {
    if (!url || typeof url !== 'string') return null;
    
    // Skip special URLs
    if (url.startsWith('about:') || 
        url.startsWith('moz-extension:') || 
        url.startsWith('chrome:') ||
        url.startsWith('file:') ||
        url.startsWith('data:')) {
      return null;
    }
    
    const urlObj = new URL(url);
    // Remove 'www.' prefix if present
    return urlObj.hostname.replace(/^www\./, '');
  } catch (e) {
    log(`Failed to parse URL: ${url}`, e);
    return null;
  }
}

// Get muted domains from storage with fallback
async function getMutedDomains() {
  try {
    const result = await browser.storage.local.get(MUTED_DOMAINS_KEY);
    return result[MUTED_DOMAINS_KEY] || [];
  } catch (e) {
    log('Failed to get muted domains from storage', e);
    return [];
  }
}

// Save muted domains to storage with retry
async function saveMutedDomains(domains, retryCount = 0) {
  try {
    await browser.storage.local.set({ [MUTED_DOMAINS_KEY]: domains });
    return true;
  } catch (e) {
    log('Failed to save muted domains', e);
    
    // Retry logic for temporary failures
    if (retryCount < 3) {
      await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1)));
      return saveMutedDomains(domains, retryCount + 1);
    }
    
    return false;
  }
}

// Check if a domain is muted
async function isDomainMuted(domain) {
  if (!domain) return false;
  
  try {
    const mutedDomains = await getMutedDomains();
    return mutedDomains.includes(domain);
  } catch (e) {
    log('Error checking if domain is muted', e);
    return false;
  }
}

// Mute a domain
async function muteDomain(domain) {
  if (!domain) return false;
  
  try {
    const mutedDomains = await getMutedDomains();
    if (!mutedDomains.includes(domain)) {
      mutedDomains.push(domain);
      const saved = await saveMutedDomains(mutedDomains);
      if (saved) {
        log(`Muted domain: ${domain}`);
        return true;
      }
    }
    return true; // Already muted
  } catch (e) {
    log(`Failed to mute domain: ${domain}`, e);
    return false;
  }
}

// Unmute a domain
async function unmuteDomain(domain) {
  if (!domain) return false;
  
  try {
    const mutedDomains = await getMutedDomains();
    const index = mutedDomains.indexOf(domain);
    if (index > -1) {
      mutedDomains.splice(index, 1);
      const saved = await saveMutedDomains(mutedDomains);
      if (saved) {
        log(`Unmuted domain: ${domain}`);
        return true;
      }
    }
    return true; // Already unmuted
  } catch (e) {
    log(`Failed to unmute domain: ${domain}`, e);
    return false;
  }
}

// Safely update tab mute state
async function updateTabMuteState(tabId, muted) {
  try {
    // Verify tab still exists
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    
    // Skip if already in desired state
    if (tab.mutedInfo && tab.mutedInfo.muted === muted) {
      return true;
    }
    
    await browser.tabs.update(tabId, { muted });
    return true;
  } catch (e) {
    // Tab might have been closed or we lack permission
    if (!e.message?.includes('No tab with id')) {
      log(`Failed to update tab mute state: ${tabId}`, e);
    }
    return false;
  }
}

// Update context menu when right-clicking a tab
async function updateContextMenu(tab) {
  try {
    // Remove existing menu items
    await browser.contextMenus.removeAll();
    
    if (!tab || !tab.url) return;
    
    const domain = getDomain(tab.url);
    if (!domain) return;
    
    const isMuted = await isDomainMuted(domain);
    
    browser.contextMenus.create({
      id: isMuted ? 'unmute-site' : 'mute-site',
      title: isMuted ? 'Unmute Site' : 'Mute Site',
      contexts: ['tab']
    });
  } catch (e) {
    log('Failed to update context menu', e);
  }
}

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab || !tab.url) return;
    
    const domain = getDomain(tab.url);
    if (!domain) return;
    
    if (info.menuItemId === 'mute-site') {
      const muted = await muteDomain(domain);
      if (muted) {
        // Mute the current tab
        await updateTabMuteState(tab.id, true);
        // Mute all other tabs with the same domain
        await muteAllTabsForDomain(domain, true);
      }
    } else if (info.menuItemId === 'unmute-site') {
      const unmuted = await unmuteDomain(domain);
      if (unmuted) {
        // Unmute the current tab
        await updateTabMuteState(tab.id, false);
        // Unmute all other tabs with the same domain
        await muteAllTabsForDomain(domain, false);
      }
    }
  } catch (e) {
    log('Error handling context menu click', e);
  }
});

// Mute/unmute all tabs for a specific domain
async function muteAllTabsForDomain(domain, mute) {
  if (!domain) return;
  
  try {
    const tabs = await browser.tabs.query({});
    const promises = [];
    
    for (const tab of tabs) {
      if (!tab.url) continue;
      
      const tabDomain = getDomain(tab.url);
      if (tabDomain === domain) {
        promises.push(updateTabMuteState(tab.id, mute));
      }
    }
    
    // Process in parallel but don't fail if some tabs error
    await Promise.allSettled(promises);
  } catch (e) {
    log('Error muting/unmuting tabs for domain', e);
  }
}

// Check and apply mute status when a tab is updated
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    // Only check when URL changes or page loads
    if (!changeInfo.url && changeInfo.status !== 'loading' && changeInfo.status !== 'complete') {
      return;
    }
    
    if (!tab.url) return;
    
    const domain = getDomain(tab.url);
    if (!domain) return;
    
    const shouldMute = await isDomainMuted(domain);
    await updateTabMuteState(tabId, shouldMute);
  } catch (e) {
    log('Error in tab update listener', e);
  }
});

// Setup context menu when tab is activated
browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId).catch(() => null);
    if (tab) {
      await updateContextMenu(tab);
    }
  } catch (e) {
    log('Error in tab activated listener', e);
  }
});

// Update context menu before it's shown (Firefox 60+)
if (browser.contextMenus.onShown) {
  browser.contextMenus.onShown.addListener(async (info, tab) => {
    try {
      await updateContextMenu(tab);
      browser.contextMenus.refresh();
    } catch (e) {
      log('Error updating context menu on show', e);
    }
  });
}

// Apply mute states to all tabs on startup/install
async function applyMuteStatesToAllTabs() {
  try {
    const [tabs, mutedDomains] = await Promise.all([
      browser.tabs.query({}),
      getMutedDomains()
    ]);
    
    if (mutedDomains.length === 0) return;
    
    const promises = [];
    for (const tab of tabs) {
      if (!tab.url) continue;
      
      const domain = getDomain(tab.url);
      if (domain && mutedDomains.includes(domain)) {
        promises.push(updateTabMuteState(tab.id, true));
      }
    }
    
    await Promise.allSettled(promises);
    log(`Applied mute states to ${promises.length} tabs`);
  } catch (e) {
    log('Error applying mute states to tabs', e);
  }
}

// Check all existing tabs on startup
browser.runtime.onStartup.addListener(() => {
  applyMuteStatesToAllTabs();
});

// Check tabs when extension is installed/updated
browser.runtime.onInstalled.addListener((details) => {
  log(`Extension ${details.reason}: ${details.previousVersion || 'first install'}`);
  applyMuteStatesToAllTabs();
});

// Handle storage changes (in case of sync or external changes)
browser.storage.onChanged.addListener(async (changes, areaName) => {
  try {
    if (areaName === 'local' && changes[MUTED_DOMAINS_KEY]) {
      log('Muted domains changed, reapplying states');
      await applyMuteStatesToAllTabs();
    }
  } catch (e) {
    log('Error handling storage change', e);
  }
});

// Cleanup function for any persistent connections or timers
browser.runtime.onSuspend?.addListener(() => {
  log('Extension suspending...');
});

log('Simple Site Muter initialized');