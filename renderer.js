const { ipcRenderer } = require('electron');
const { DefaultAzureCredential } = require('@azure/identity');
const { KeyVaultManagementClient } = require('@azure/arm-keyvault');
const { SecretClient } = require('@azure/keyvault-secrets');
const { KeyClient } = require('@azure/keyvault-keys');
const { SubscriptionClient } = require('@azure/arm-subscriptions');
const fs = require('fs');
const path = require('path');

// Global state with performance optimizations
let allKeyVaults = [];
let allSecretsByVault = new Map(); // Using Map for better performance
let allKeysByVault = new Map();    // Using Map for better performance
let currentKeyVault = null;
let globalSearchResults = [];
let currentTab = 'secrets';
let filteredKeyVaults = []; // For key vault search
let loadedVaults = new Set(); // Track which vaults have been loaded
let currentPage = 1;
let itemsPerPage = 50; // Show 50 items per page

// Performance optimizations
let vaultsPerPage = 20; // Show only 20 vaults at a time
let currentVaultPage = 1;
let loadingQueue = []; // Queue for background loading
let isBackgroundLoading = false;
let searchCache = new Map(); // Cache search results
let lastSearchTerm = '';
let searchTimeout = null;

// Performance monitoring and memory management
let performanceMetrics = {
    vaultLoadTime: 0,
    searchTime: 0,
    memoryUsage: 0,
    loadedVaultsCount: 0,
    totalSecrets: 0,
    totalKeys: 0
};

// Logging system
let activityLog = [];
let maxLogEntries = 100;

// DOM elements
const keyvaultList = document.getElementById('keyvaultList');
const secretsContainer = document.getElementById('secretsContainer');
const keysContainer = document.getElementById('keysContainer');
const mainHeader = document.getElementById('mainHeader');
const globalSearchInput = document.getElementById('globalSearchInput');
const clearGlobalSearchBtn = document.getElementById('clearGlobalSearch');
const refreshKeyVaultsBtn = document.getElementById('refreshKeyVaults');
const keyvaultSearchInput = document.getElementById('keyvaultSearchInput');
const addSecretBtn = document.getElementById('addSecret');
const addSecretModal = document.getElementById('addSecretModal');
const closeModalBtn = document.getElementById('closeModal');
const cancelAddBtn = document.getElementById('cancelAdd');
const saveSecretBtn = document.getElementById('saveSecret');

// Tab elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    addActivityLog();
    addPerformanceIndicator();
    await loadAllKeyVaults();
    updatePerformanceMetrics();
});

// Activity logging system
function addActivityLog() {
    const logContainer = document.createElement('div');
    logContainer.id = 'activityLog';
    logContainer.className = 'activity-log-container';
    logContainer.innerHTML = `
        <div class="activity-log-header">
            <h3><i class="fas fa-list"></i> Activity Log</h3>
            <button class="btn btn-secondary btn-sm" onclick="clearActivityLog()">
                <i class="fas fa-trash"></i> Clear
            </button>
        </div>
        <div class="activity-log-content" id="activityLogContent">
            <div class="log-entry info">
                <span class="log-time">${new Date().toLocaleTimeString()}</span>
                <span class="log-message">Application started</span>
            </div>
        </div>
    `;
    
    // Insert after the sidebar
    const sidebar = document.querySelector('.sidebar');
    sidebar.parentNode.insertBefore(logContainer, sidebar.nextSibling);
}

function addLogEntry(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = {
        timestamp,
        message,
        type
    };
    
    activityLog.push(logEntry);
    
    // Keep only the last maxLogEntries
    if (activityLog.length > maxLogEntries) {
        activityLog = activityLog.slice(-maxLogEntries);
    }
    
    // Update the UI
    updateActivityLogUI();
}

function updateActivityLogUI() {
    const logContent = document.getElementById('activityLogContent');
    if (!logContent) return;
    
    logContent.innerHTML = activityLog.map(entry => `
        <div class="log-entry ${entry.type}">
            <span class="log-time">${entry.timestamp}</span>
            <span class="log-message">${entry.message}</span>
        </div>
    `).join('');
    
    // Auto-scroll to bottom
    logContent.scrollTop = logContent.scrollHeight;
}

function clearActivityLog() {
    activityLog = [];
    updateActivityLogUI();
    addLogEntry('Activity log cleared', 'info');
}

// Enhanced loading function with detailed logging
function showLoadingWithProgress(container, initialMessage) {
    const loadingId = 'loading-' + Date.now();
    container.innerHTML = `
        <div id="${loadingId}" class="loading-with-progress">
            <div class="loading-header">
                <i class="fas fa-spinner fa-spin"></i>
                <span class="loading-message">${initialMessage}</span>
            </div>
            <div class="loading-progress-bar">
                <div class="progress-fill" style="width: 0%"></div>
            </div>
            <div class="loading-details" id="${loadingId}-details"></div>
        </div>
    `;
    
    return {
        updateMessage: (message) => {
            const loadingElement = document.getElementById(loadingId);
            if (loadingElement) {
                const messageElement = loadingElement.querySelector('.loading-message');
                if (messageElement) {
                    messageElement.textContent = message;
                }
            }
        },
        updateProgress: (percent, details) => {
            const loadingElement = document.getElementById(loadingId);
            if (loadingElement) {
                const progressFill = loadingElement.querySelector('.progress-fill');
                const detailsElement = document.getElementById(`${loadingId}-details`);
                
                if (progressFill) {
                    progressFill.style.width = `${percent}%`;
                }
                
                if (detailsElement && details) {
                    detailsElement.innerHTML = details;
                }
            }
        },
        complete: () => {
            const loadingElement = document.getElementById(loadingId);
            if (loadingElement) {
                loadingElement.remove();
            }
        }
    };
}

function setupEventListeners() {
    refreshKeyVaultsBtn.addEventListener('click', loadAllKeyVaults);
    
    // Debounced global search for better performance
    globalSearchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => handleGlobalSearch(), 300); // 300ms debounce
    });
    
    clearGlobalSearchBtn.addEventListener('click', clearGlobalSearch);
    
    // Fixed Key Vault search - ensure the input exists
    if (keyvaultSearchInput) {
        keyvaultSearchInput.addEventListener('input', handleKeyVaultSearch);
    } else {
        console.error('Key Vault search input not found');
        addLogEntry('Error: Key Vault search input not found', 'error');
    }
    
    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Modal events
    addSecretBtn && addSecretBtn.addEventListener('click', showAddSecretModal);
    closeModalBtn && closeModalBtn.addEventListener('click', hideAddSecretModal);
    cancelAddBtn && cancelAddBtn.addEventListener('click', hideAddSecretModal);
    saveSecretBtn && saveSecretBtn.addEventListener('click', saveSecret);
    addSecretModal && addSecretModal.addEventListener('click', (e) => {
        if (e.target === addSecretModal) hideAddSecretModal();
    });
    
    // Key modal events
    document.getElementById('closeKeyModal') && document.getElementById('closeKeyModal').addEventListener('click', hideAddKeyModal);
    document.getElementById('cancelAddKey') && document.getElementById('cancelAddKey').addEventListener('click', hideAddKeyModal);
    document.getElementById('saveKey') && document.getElementById('saveKey').addEventListener('click', saveKey);
    document.getElementById('addKeyModal') && document.getElementById('addKeyModal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('addKeyModal')) hideAddKeyModal();
    });
    
    // Export modal events
    document.getElementById('closeExportModal') && document.getElementById('closeExportModal').addEventListener('click', hideExportModal);
    document.getElementById('cancelExport') && document.getElementById('cancelExport').addEventListener('click', hideExportModal);
    document.getElementById('exportData') && document.getElementById('exportData').addEventListener('click', exportData);
    document.getElementById('exportModal') && document.getElementById('exportModal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('exportModal')) hideExportModal();
    });
}

// Tab switching
function switchTab(tabName) {
    currentTab = tabName;
    currentPage = 1; // Reset pagination when switching tabs
    
    // Update tab buttons
    tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab panes
    tabPanes.forEach(pane => {
        pane.classList.toggle('active', pane.id === `${tabName}Tab`);
    });
    
    // Load content for the selected tab
    if (currentKeyVault) {
        if (tabName === 'secrets') {
            loadSecretsForKeyVault(currentKeyVault);
        } else if (tabName === 'keys') {
            loadKeysForKeyVault(currentKeyVault);
        }
    }
}

// Optimized Key Vault loading with pagination and detailed logging
async function loadAllKeyVaults() {
    addLogEntry('Starting to load Key Vaults...', 'info');
    const loadingProgress = showLoadingWithProgress(keyvaultList, 'Initializing Azure connection...');
    
    allKeyVaults = [];
    allSecretsByVault.clear();
    allKeysByVault.clear();
    loadedVaults.clear();
    searchCache.clear();
    currentVaultPage = 1;
    
    try {
        loadingProgress.updateMessage('Creating Azure credentials...');
        addLogEntry('Creating Azure credentials', 'info');
        const credential = new DefaultAzureCredential();
        
        loadingProgress.updateMessage('Connecting to Azure subscriptions...');
        addLogEntry('Connecting to Azure subscriptions', 'info');
        const subscriptionClient = new SubscriptionClient(credential);
        
        loadingProgress.updateMessage('Fetching subscriptions...');
        addLogEntry('Fetching subscriptions from Azure', 'info');
        
        const subscriptions = [];
        for await (const sub of subscriptionClient.subscriptions.list()) {
            subscriptions.push(sub);
            addLogEntry(`Found subscription: ${sub.displayName} (${sub.subscriptionId})`, 'success');
        }
        
        addLogEntry(`Total subscriptions found: ${subscriptions.length}`, 'info');
        
        if (subscriptions.length === 0) {
            addLogEntry('No subscriptions found. Please check your Azure account and permissions.', 'error');
            showError(keyvaultList, 'No subscriptions found. Please check your Azure account and permissions.');
            loadingProgress.complete();
            return;
        }
        
        loadingProgress.updateMessage('Discovering Key Vaults across subscriptions...');
        addLogEntry('Starting Key Vault discovery across all subscriptions', 'info');
        
        // Load Key Vaults in parallel for better performance
        const vaultPromises = subscriptions.map(async (sub, index) => {
            try {
                loadingProgress.updateProgress(
                    (index / subscriptions.length) * 50, 
                    `Checking subscription: ${sub.displayName}`
                );
                
                const kvClient = new KeyVaultManagementClient(credential, sub.subscriptionId);
                const vaults = [];
                
                for await (const vault of kvClient.vaults.list()) {
                    vaults.push({
                        id: vault.id,
                        name: vault.name,
                        location: vault.location,
                        resourceGroup: vault.resourceGroup,
                        subscriptionId: sub.subscriptionId,
                        properties: vault.properties
                    });
                    addLogEntry(`Found Key Vault: ${vault.name} in ${vault.location}`, 'success');
                }
                
                addLogEntry(`Found ${vaults.length} Key Vaults in subscription: ${sub.displayName}`, 'info');
                return vaults;
            } catch (error) {
                addLogEntry(`Error fetching Key Vaults for subscription ${sub.displayName}: ${error.message}`, 'error');
                console.error('Error fetching Key Vaults for subscription', sub.displayName, ':', error);
                showNotification(`Warning: Could not load Key Vaults for subscription "${sub.displayName}"`, 'warning');
                return [];
            }
        });
        
        const vaultResults = await Promise.all(vaultPromises);
        allKeyVaults = vaultResults.flat();
        
        addLogEntry(`Total Key Vaults discovered: ${allKeyVaults.length}`, 'success');
        
        loadingProgress.updateProgress(100, 'Rendering Key Vault list...');
        filteredKeyVaults = [...allKeyVaults]; // Initialize filtered list
        renderKeyVaultsPaginated(filteredKeyVaults);
        
        loadingProgress.complete();
        
        // Start background loading of first few vaults
        addLogEntry('Starting background loading of first 5 Key Vaults...', 'info');
        startBackgroundLoading();
        
    } catch (error) {
        addLogEntry(`Failed to load Key Vaults: ${error.message}`, 'error');
        console.error('Error loading Key Vaults:', error);
        showError(keyvaultList, `Failed to load Key Vaults: ${error.message}. Please check your Azure credentials and permissions.`);
        showNotification('Failed to load Key Vaults. Check console for details.', 'error');
        loadingProgress.complete();
    }
}

// Background loading system for better performance with detailed logging
async function startBackgroundLoading() {
    if (isBackgroundLoading) return;
    
    isBackgroundLoading = true;
    const vaultsToLoad = allKeyVaults.slice(0, 5); // Load first 5 vaults in background
    
    addLogEntry(`Starting background loading of ${vaultsToLoad.length} Key Vaults`, 'info');
    
    for (let i = 0; i < vaultsToLoad.length; i++) {
        const vault = vaultsToLoad[i];
        if (!loadedVaults.has(vault.name)) {
            try {
                addLogEntry(`Loading data for Key Vault: ${vault.name} (${i + 1}/${vaultsToLoad.length})`, 'info');
                await loadVaultDataInBackground(vault);
                loadedVaults.add(vault.name);
                addLogEntry(`Successfully loaded Key Vault: ${vault.name}`, 'success');
            } catch (error) {
                addLogEntry(`Failed to load Key Vault ${vault.name}: ${error.message}`, 'error');
                console.warn(`Background loading failed for vault ${vault.name}:`, error);
            }
        }
    }
    
    isBackgroundLoading = false;
    addLogEntry('Background loading completed', 'success');
}

// Load vault data in background without blocking UI with detailed logging
async function loadVaultDataInBackground(vault) {
    const startTime = performance.now();
    
    addLogEntry(`Connecting to Key Vault: ${vault.name}`, 'info');
    const credential = new DefaultAzureCredential();
    const vaultUrl = `https://${vault.name}.vault.azure.net/`;
    
    // Load secrets and keys in parallel
    addLogEntry(`Loading secrets and keys from ${vault.name}...`, 'info');
    const [secrets, keys] = await Promise.all([
        loadSecretsForVault(vaultUrl, credential, vault.name),
        loadKeysForVault(vaultUrl, credential, vault.name)
    ]);
    
    allSecretsByVault.set(vault.name, secrets);
    allKeysByVault.set(vault.name, keys);
    
    const endTime = performance.now();
    performanceMetrics.vaultLoadTime = (endTime - startTime) / 1000; // Convert to seconds
    
    addLogEntry(`Loaded ${vault.name}: ${secrets.length} secrets, ${keys.length} keys in ${performanceMetrics.vaultLoadTime.toFixed(2)}s`, 'success');
    console.log(`Loaded vault ${vault.name} in ${performanceMetrics.vaultLoadTime.toFixed(2)}s (${secrets.length} secrets, ${keys.length} keys)`);
    
    updatePerformanceMetrics();
}

// Optimized secret loading with detailed logging
async function loadSecretsForVault(vaultUrl, credential, vaultName) {
    const secretClient = new SecretClient(vaultUrl, credential);
    const secrets = [];
    
    try {
        addLogEntry(`Listing secrets in ${vaultName}...`, 'info');
        let secretCount = 0;
        
        for await (const secretProp of secretClient.listPropertiesOfSecrets()) {
            try {
                const secret = await secretClient.getSecret(secretProp.name);
                secrets.push({
                    name: secret.name,
                    value: secret.value,
                    version: secret.properties.version,
                    created: secret.properties.createdOn,
                    updated: secret.properties.updatedOn,
                    expires: secret.properties.expiresOn,
                    enabled: secret.properties.enabled
                });
                secretCount++;
                
                if (secretCount % 10 === 0) {
                    addLogEntry(`Loaded ${secretCount} secrets from ${vaultName}...`, 'info');
                }
            } catch (error) {
                addLogEntry(`Failed to get secret ${secretProp.name} from ${vaultName}: ${error.message}`, 'warning');
                console.warn(`Failed to get secret ${secretProp.name}:`, error);
            }
        }
        
        addLogEntry(`Successfully loaded ${secrets.length} secrets from ${vaultName}`, 'success');
    } catch (error) {
        addLogEntry(`Error loading secrets from ${vaultName}: ${error.message}`, 'error');
        console.error('Error loading secrets:', error);
    }
    
    return secrets;
}

// Optimized key loading with detailed logging
async function loadKeysForVault(vaultUrl, credential, vaultName) {
    const keyClient = new KeyClient(vaultUrl, credential);
    const keys = [];
    
    try {
        addLogEntry(`Listing keys in ${vaultName}...`, 'info');
        let keyCount = 0;
        
        for await (const keyProp of keyClient.listPropertiesOfKeys()) {
            try {
                const key = await keyClient.getKey(keyProp.name);
                keys.push({
                    name: key.name,
                    keyType: key.keyType,
                    keySize: key.keySize,
                    version: key.properties.version,
                    created: key.properties.createdOn,
                    updated: key.properties.updatedOn,
                    expires: key.properties.expiresOn,
                    enabled: key.properties.enabled
                });
                keyCount++;
                
                if (keyCount % 5 === 0) {
                    addLogEntry(`Loaded ${keyCount} keys from ${vaultName}...`, 'info');
                }
            } catch (error) {
                addLogEntry(`Failed to get key ${keyProp.name} from ${vaultName}: ${error.message}`, 'warning');
                console.warn(`Failed to get key ${keyProp.name}:`, error);
            }
        }
        
        addLogEntry(`Successfully loaded ${keys.length} keys from ${vaultName}`, 'success');
    } catch (error) {
        addLogEntry(`Error loading keys from ${vaultName}: ${error.message}`, 'error');
        console.error('Error loading keys:', error);
    }
    
    return keys;
}

// Key Vault search functionality with pagination
function handleKeyVaultSearch() {
    const searchTerm = keyvaultSearchInput.value.toLowerCase().trim();
    
    if (!searchTerm) {
        filteredKeyVaults = [...allKeyVaults];
    } else {
        filteredKeyVaults = allKeyVaults.filter(kv => 
            kv.name.toLowerCase().includes(searchTerm) ||
            kv.location.toLowerCase().includes(searchTerm) ||
            kv.resourceGroup.toLowerCase().includes(searchTerm)
        );
    }
    
    currentVaultPage = 1; // Reset to first page when searching
    renderKeyVaultsPaginated(filteredKeyVaults);
}

// Paginated Key Vault rendering for better performance
function renderKeyVaultsPaginated(keyVaults) {
    keyvaultList.innerHTML = '';
    
    if (keyVaults.length === 0) {
        const message = keyvaultSearchInput.value.trim() ? 'No Key Vaults match your search' : 'No Key Vaults found';
        keyvaultList.innerHTML = `<div class="loading">${message}</div>`;
        return;
    }
    
    // Calculate pagination
    const totalVaultPages = Math.ceil(keyVaults.length / vaultsPerPage);
    const startIndex = (currentVaultPage - 1) * vaultsPerPage;
    const endIndex = startIndex + vaultsPerPage;
    const pageVaults = keyVaults.slice(startIndex, endIndex);
    
    // Add count indicator
    const countDiv = document.createElement('div');
    countDiv.className = 'keyvault-count';
    countDiv.textContent = `Showing ${startIndex + 1}-${Math.min(endIndex, keyVaults.length)} of ${keyVaults.length} Key Vaults`;
    keyvaultList.appendChild(countDiv);
    
    // Render vaults for current page
    pageVaults.forEach(kv => {
        const vaultDiv = document.createElement('div');
        vaultDiv.className = 'keyvault-item';
        vaultDiv.innerHTML = `
            <div class="keyvault-info">
                <h3>${kv.name}</h3>
                <p><strong>Location:</strong> ${kv.location}</p>
                <p><strong>Resource Group:</strong> ${kv.resourceGroup}</p>
                <p><strong>Subscription:</strong> ${kv.subscriptionId}</p>
                ${loadedVaults.has(kv.name) ? '<span class="loaded-badge">✓ Loaded</span>' : '<span class="not-loaded-badge">Not Loaded</span>'}
            </div>
            <button class="btn btn-primary" onclick="selectKeyVault(${JSON.stringify(kv).replace(/"/g, '&quot;')})">
                <i class="fas fa-eye"></i> View
            </button>
        `;
        keyvaultList.appendChild(vaultDiv);
    });
    
    // Add pagination controls for vaults
    if (totalVaultPages > 1) {
        const paginationDiv = document.createElement('div');
        paginationDiv.className = 'vault-pagination';
        paginationDiv.innerHTML = `
            <button class="btn btn-secondary" onclick="changeVaultPage(${currentVaultPage - 1})" ${currentVaultPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i> Previous
            </button>
            <span class="page-info">Page ${currentVaultPage} of ${totalVaultPages}</span>
            <button class="btn btn-secondary" onclick="changeVaultPage(${currentVaultPage + 1})" ${currentVaultPage >= totalVaultPages ? 'disabled' : ''}>
                Next <i class="fas fa-chevron-right"></i>
            </button>
        `;
        keyvaultList.appendChild(paginationDiv);
    }
}

// Vault pagination function
function changeVaultPage(newPage) {
    if (newPage < 1) return;
    
    const totalVaultPages = Math.ceil(filteredKeyVaults.length / vaultsPerPage);
    if (newPage > totalVaultPages) return;
    
    currentVaultPage = newPage;
    renderKeyVaultsPaginated(filteredKeyVaults);
}

// Optimized Key Vault selection with lazy loading
async function selectKeyVault(keyVault) {
    currentKeyVault = keyVault;
    currentPage = 1;
    
    // Load vault data if not already loaded
    if (!loadedVaults.has(keyVault.name)) {
        showLoading(secretsContainer, `Loading data for ${keyVault.name}...`);
        try {
            await loadVaultDataInBackground(keyVault);
            loadedVaults.add(keyVault.name);
        } catch (error) {
            console.error('Error loading vault data:', error);
            showError(secretsContainer, `Failed to load data for ${keyVault.name}: ${error.message}`);
            return;
        }
    }
    
    renderKeyVaultHeader(keyVault);
    
    if (currentTab === 'secrets') {
        renderSecrets(allSecretsByVault.get(keyVault.name) || []);
    } else {
        renderKeys(allKeysByVault.get(keyVault.name) || []);
    }
}

function renderKeyVaultHeader(keyVault) {
    mainHeader.innerHTML = `
        <h2><i class="fas fa-vault"></i> ${keyVault.name}</h2>
        <div class="header-actions">
            <button class="btn btn-secondary" id="exportBtn">
                <i class="fas fa-download"></i> Export
            </button>
            <button class="btn btn-warning" id="bulkOperationsBtn">
                <i class="fas fa-tasks"></i> Bulk Operations
            </button>
            <button class="btn btn-primary" id="refreshBtn">
                <i class="fas fa-sync"></i> Refresh
            </button>
            ${currentTab === 'secrets' ? 
                `<button class="btn btn-success" id="addSecret">
                    <i class="fas fa-plus"></i> Add Secret
                </button>` : 
                `<button class="btn btn-success" id="addKey">
                    <i class="fas fa-plus"></i> Add Key
                </button>`
            }
        </div>
    `;
    
    // Add event listeners
    document.getElementById('refreshBtn').addEventListener('click', () => {
        if (currentTab === 'secrets') {
            loadSecretsForKeyVault(keyVault);
        } else {
            loadKeysForKeyVault(keyVault);
        }
    });
    
    if (currentTab === 'secrets') {
        document.getElementById('addSecret').addEventListener('click', showAddSecretModal);
    } else {
        document.getElementById('addKey').addEventListener('click', showAddKeyModal);
    }
    
    document.getElementById('exportBtn').addEventListener('click', showExportModal);
    document.getElementById('bulkOperationsBtn').addEventListener('click', showBulkOperations);
}

// Optimized global search with caching and background processing
async function handleGlobalSearch() {
    const searchTerm = globalSearchInput.value.toLowerCase().trim();
    if (!searchTerm) {
        if (currentKeyVault) {
            renderKeyVaultHeader(currentKeyVault);
            if (currentTab === 'secrets') {
                renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
            } else {
                renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
            }
        } else {
            showWelcomeMessage();
        }
        return;
    }
    
    // Check cache first
    const cacheKey = `${searchTerm}_${currentTab}`;
    if (searchCache.has(cacheKey)) {
        renderGlobalSearchResults(searchCache.get(cacheKey), searchTerm);
        return;
    }
    
    showLoading(currentTab === 'secrets' ? secretsContainer : keysContainer, 'Searching across loaded Key Vaults...');
    mainHeader.innerHTML = `<h2><i class="fas fa-search"></i> Global Search Results</h2>`;
    
    // Search only in loaded vaults first (fast search)
    const searchResults = await searchLoadedVaults(searchTerm);
    
    // Cache the results
    searchCache.set(cacheKey, searchResults);
    
    // If no results in loaded vaults, offer to search all vaults
    if (searchResults.length === 0) {
        const unloadedVaults = allKeyVaults.filter(kv => !loadedVaults.has(kv.name));
        if (unloadedVaults.length > 0) {
            const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
            container.innerHTML = `
                <div class="welcome-message">
                    <i class="fas fa-search fa-3x"></i>
                    <h2>No results in loaded Key Vaults</h2>
                    <p>No secrets or keys matching "${searchTerm}" were found in the currently loaded Key Vaults.</p>
                    <p>${unloadedVaults.length} Key Vaults are not yet loaded. Would you like to search all Key Vaults?</p>
                    <button class="btn btn-primary" onclick="searchAllVaults('${searchTerm}')">
                        <i class="fas fa-search"></i> Search All Key Vaults
                    </button>
                </div>
            `;
            return;
        }
    }
    
    renderGlobalSearchResults(searchResults, searchTerm);
}

// Search only in loaded vaults (fast)
async function searchLoadedVaults(searchTerm) {
    const startTime = performance.now();
    
    const searchResults = [];
    
    // Search secrets in loaded vaults
    for (const [vaultName, secrets] of allSecretsByVault.entries()) {
        for (const secret of secrets) {
            if (fuzzySearch(secret.name.toLowerCase(), searchTerm)) {
                searchResults.push({ ...secret, vaultName, type: 'secret' });
            }
        }
    }
    
    // Search keys in loaded vaults
    for (const [vaultName, keys] of allKeysByVault.entries()) {
        for (const key of keys) {
            if (fuzzySearch(key.name.toLowerCase(), searchTerm)) {
                searchResults.push({ ...key, vaultName, type: 'key' });
            }
        }
    }
    
    const endTime = performance.now();
    performanceMetrics.searchTime = (endTime - startTime) / 1000; // Convert to seconds
    
    console.log(`Search completed in ${performanceMetrics.searchTime.toFixed(2)}s, found ${searchResults.length} results`);
    
    return searchResults;
}

// Optimized function to search all vaults with background loading
async function searchAllVaults(searchTerm) {
    showLoading(currentTab === 'secrets' ? secretsContainer : keysContainer, 'Loading and searching all Key Vaults...');
    
    // Load data for unloaded vaults in batches
    const unloadedVaults = allKeyVaults.filter(kv => !loadedVaults.has(kv.name));
    const batchSize = 3; // Load 3 vaults at a time to avoid overwhelming the API
    
    for (let i = 0; i < unloadedVaults.length; i += batchSize) {
        const batch = unloadedVaults.slice(i, i + batchSize);
        const batchPromises = batch.map(async (vault) => {
            try {
                await loadVaultDataInBackground(vault);
                loadedVaults.add(vault.name);
                return true;
            } catch (error) {
                console.warn(`Failed to load data for vault ${vault.name}:`, error);
                return false;
            }
        });
        
        await Promise.all(batchPromises);
        
        // Update progress
        const progress = Math.min(((i + batchSize) / unloadedVaults.length) * 100, 100);
        const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
        container.innerHTML = `<div class="loading">Loading Key Vaults... ${Math.round(progress)}%</div>`;
    }
    
    // Update key vault list to show loading status
    renderKeyVaultsPaginated(filteredKeyVaults);
    
    // Now search all loaded data
    const searchResults = await searchLoadedVaults(searchTerm);
    
    // Cache the results
    const cacheKey = `${searchTerm}_${currentTab}`;
    searchCache.set(cacheKey, searchResults);
    
    renderGlobalSearchResults(searchResults, searchTerm);
}

// Optimized secret loading with caching
async function loadSecretsForKeyVault(keyVault) {
    // Check if already loaded
    if (allSecretsByVault.has(keyVault.name)) {
        renderSecrets(allSecretsByVault.get(keyVault.name));
        return;
    }
    
    showLoading(secretsContainer, 'Loading secrets...');
    try {
        console.log('Loading secrets for Key Vault:', keyVault.name);
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${keyVault.name}.vault.azure.net/`;
        console.log('Key Vault URL:', vaultUrl);
        
        const secrets = await loadSecretsForVault(vaultUrl, credential, keyVault.name);
        console.log('Total secrets found:', secrets.length);
        allSecretsByVault.set(keyVault.name, secrets);
        renderSecrets(secrets);
        showNotification(`Loaded ${secrets.length} secrets from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading secrets for', keyVault.name, ':', error);
        showError(secretsContainer, `Failed to load secrets: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load secrets. Check console for details.', 'error');
    }
}

// Optimized key loading with caching
async function loadKeysForKeyVault(keyVault) {
    // Check if already loaded
    if (allKeysByVault.has(keyVault.name)) {
        renderKeys(allKeysByVault.get(keyVault.name));
        return;
    }
    
    showLoading(keysContainer, 'Loading keys...');
    try {
        console.log('Loading keys for Key Vault:', keyVault.name);
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${keyVault.name}.vault.azure.net/`;
        
        const keys = await loadKeysForVault(vaultUrl, credential, keyVault.name);
        console.log('Total keys found:', keys.length);
        allKeysByVault.set(keyVault.name, keys);
        renderKeys(keys);
        showNotification(`Loaded ${keys.length} keys from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading keys for', keyVault.name, ':', error);
        showError(keysContainer, `Failed to load keys: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load keys. Check console for details.', 'error');
    }
}

function renderGlobalSearchResults(results, searchTerm) {
    const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
    container.innerHTML = '';
    
    if (results.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-search fa-3x"></i>
                <h2>No results found</h2>
                <p>No secrets or keys matching "${searchTerm}" were found in any Key Vault.</p>
            </div>
        `;
        return;
    }
    
    // Group by vault
    const grouped = {};
    for (const result of results) {
        if (!grouped[result.vaultName]) grouped[result.vaultName] = [];
        grouped[result.vaultName].push(result);
    }
    
    for (const [vaultName, items] of Object.entries(grouped)) {
        const groupHeader = document.createElement('h3');
        groupHeader.innerHTML = `<i class="fas fa-vault"></i> ${vaultName}`;
        container.appendChild(groupHeader);
        
        items.forEach(item => {
            if (item.type === 'secret') {
                const secretCard = createSecretCard(item);
                container.appendChild(secretCard);
            } else {
                const keyCard = createKeyCard(item);
                container.appendChild(keyCard);
            }
        });
    }
}

// Performance monitoring function
function updatePerformanceMetrics() {
    performanceMetrics.loadedVaultsCount = loadedVaults.size;
    performanceMetrics.totalSecrets = Array.from(allSecretsByVault.values()).reduce((sum, secrets) => sum + secrets.length, 0);
    performanceMetrics.totalKeys = Array.from(allKeysByVault.values()).reduce((sum, keys) => sum + keys.length, 0);
    
    // Update memory usage indicator if it exists
    const memoryIndicator = document.getElementById('memoryIndicator');
    if (memoryIndicator) {
        const totalItems = performanceMetrics.totalSecrets + performanceMetrics.totalKeys;
        memoryIndicator.textContent = `Vaults: ${performanceMetrics.loadedVaultsCount} | Items: ${totalItems} | Cache: ${searchCache.size}`;
    }
}

// Memory cleanup function with performance tracking
function cleanupMemory() {
    const startTime = performance.now();
    
    // Clear old search cache entries (keep only last 10)
    const cacheEntries = Array.from(searchCache.entries());
    if (cacheEntries.length > 10) {
        const entriesToRemove = cacheEntries.slice(0, cacheEntries.length - 10);
        entriesToRemove.forEach(([key]) => searchCache.delete(key));
    }
    
    // Clear global search results if they're too large
    if (globalSearchResults.length > 1000) {
        globalSearchResults = globalSearchResults.slice(0, 1000);
    }
    
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
    
    const endTime = performance.now();
    console.log(`Memory cleanup completed in ${(endTime - startTime).toFixed(2)}ms`);
    
    updatePerformanceMetrics();
}

// Optimized fuzzy search
function fuzzySearch(text, pattern) {
    if (!pattern) return true;
    if (!text) return false;
    
    const patternChars = pattern.split('');
    let textIndex = 0;
    
    for (const char of patternChars) {
        const foundIndex = text.indexOf(char, textIndex);
        if (foundIndex === -1) return false;
        textIndex = foundIndex + 1;
    }
    
    return true;
}

// Clear global search with memory cleanup
function clearGlobalSearch() {
    globalSearchInput.value = '';
    globalSearchResults = [];
    cleanupMemory();
    
    if (currentKeyVault) {
        renderKeyVaultHeader(currentKeyVault);
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        }
    } else {
        showWelcomeMessage();
    }
}

function renderSecrets(secrets) {
    secretsContainer.innerHTML = '';
    if (secrets.length === 0) {
        secretsContainer.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-search fa-3x"></i>
                <h2>No secrets found</h2>
                <p>This Key Vault has no secrets.</p>
            </div>
        `;
        return;
    }
    
    // Add count and pagination info
    const totalPages = Math.ceil(secrets.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageSecrets = secrets.slice(startIndex, endIndex);
    
    // Add header with count and pagination
    const headerDiv = document.createElement('div');
    headerDiv.className = 'content-header';
    headerDiv.innerHTML = `
        <div class="content-info">
            <span>Showing ${startIndex + 1}-${Math.min(endIndex, secrets.length)} of ${secrets.length} secrets</span>
        </div>
        ${totalPages > 1 ? `
        <div class="pagination">
            <button class="btn btn-secondary" onclick="changePage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i> Previous
            </button>
            <span class="page-info">Page ${currentPage} of ${totalPages}</span>
            <button class="btn btn-secondary" onclick="changePage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>
                Next <i class="fas fa-chevron-right"></i>
            </button>
        </div>
        ` : ''}
    `;
    secretsContainer.appendChild(headerDiv);
    
    // Render secrets for current page
    pageSecrets.forEach(secret => {
        const secretCard = createSecretCard(secret);
        secretsContainer.appendChild(secretCard);
    });
}

function renderKeys(keys) {
    keysContainer.innerHTML = '';
    if (keys.length === 0) {
        keysContainer.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-lock fa-3x"></i>
                <h2>No keys found</h2>
                <p>This Key Vault has no cryptographic keys.</p>
            </div>
        `;
        return;
    }
    
    // Add count and pagination info
    const totalPages = Math.ceil(keys.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageKeys = keys.slice(startIndex, endIndex);
    
    // Add header with count and pagination
    const headerDiv = document.createElement('div');
    headerDiv.className = 'content-header';
    headerDiv.innerHTML = `
        <div class="content-info">
            <span>Showing ${startIndex + 1}-${Math.min(endIndex, keys.length)} of ${keys.length} keys</span>
        </div>
        ${totalPages > 1 ? `
        <div class="pagination">
            <button class="btn btn-secondary" onclick="changePage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i> Previous
            </button>
            <span class="page-info">Page ${currentPage} of ${totalPages}</span>
            <button class="btn btn-secondary" onclick="changePage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>
                Next <i class="fas fa-chevron-right"></i>
            </button>
        </div>
        ` : ''}
    `;
    keysContainer.appendChild(headerDiv);
    
    // Render keys for current page
    pageKeys.forEach(key => {
        const keyCard = createKeyCard(key);
        keysContainer.appendChild(keyCard);
    });
}

// Pagination function
function changePage(newPage) {
    if (newPage < 1) return;
    
    const currentData = currentTab === 'secrets' 
        ? (allSecretsByVault.get(currentKeyVault?.name) || [])
        : (allKeysByVault.get(currentKeyVault?.name) || []);
    
    const totalPages = Math.ceil(currentData.length / itemsPerPage);
    if (newPage > totalPages) return;
    
    currentPage = newPage;
    
    if (currentTab === 'secrets') {
        renderSecrets(currentData);
    } else {
        renderKeys(currentData);
    }
}

function showWelcomeMessage() {
    const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
    container.innerHTML = `
        <div class="welcome-message">
            <i class="fas fa-${currentTab === 'secrets' ? 'key' : 'lock'} fa-3x"></i>
            <h2>Welcome to Azure Secrets Explorer</h2>
            <p>Select a Key Vault or use global search to start exploring your ${currentTab === 'secrets' ? 'secrets' : 'keys'}</p>
        </div>
    `;
}

function showLoading(container, message) {
    container.innerHTML = `
        <div class="loading">
            <div class="loading-spinner"></div>
            ${message}
        </div>
    `;
}

function showError(container, message) {
    container.innerHTML = `
        <div class="error">
            <i class="fas fa-exclamation-triangle"></i>
            ${message}
        </div>
    `;
}

// Notification system
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 5000);
}

// Modal functions
function showAddSecretModal() {
    addSecretModal.classList.add('show');
}

function hideAddSecretModal() {
    addSecretModal.classList.remove('show');
    document.getElementById('secretName').value = '';
    document.getElementById('secretValue').value = '';
    document.getElementById('secretDescription').value = '';
}

function showAddKeyModal() {
    document.getElementById('addKeyModal').classList.add('show');
}

function hideAddKeyModal() {
    document.getElementById('addKeyModal').classList.remove('show');
    document.getElementById('keyName').value = '';
    document.getElementById('keyDescription').value = '';
}

function showExportModal() {
    document.getElementById('exportModal').classList.add('show');
}

function hideExportModal() {
    document.getElementById('exportModal').classList.remove('show');
}

// Save new secret
async function saveSecret() {
    const name = document.getElementById('secretName').value.trim();
    const value = document.getElementById('secretValue').value.trim();
    const description = document.getElementById('secretDescription').value.trim();
    
    if (!name || !value) {
        showNotification('Please fill in all required fields', 'error');
        return;
    }
    
    try {
        if (!currentKeyVault) return;
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const secretClient = new SecretClient(vaultUrl, credential);
        
        await secretClient.setSecret(name, value, { 
            tags: description ? { description } : undefined 
        });
        
        await loadSecretsForKeyVault(currentKeyVault);
        hideAddSecretModal();
        showNotification('Secret created successfully', 'success');
        
    } catch (error) {
        console.error('Error creating secret:', error);
        showNotification('Failed to create secret: ' + error.message, 'error');
    }
}

// Save new key
async function saveKey() {
    const name = document.getElementById('keyName').value.trim();
    const keyType = document.getElementById('keyType').value;
    const keySize = parseInt(document.getElementById('keySize').value);
    const description = document.getElementById('keyDescription').value.trim();
    
    if (!name) {
        showNotification('Please enter a key name', 'error');
        return;
    }
    
    try {
        if (!currentKeyVault) return;
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const keyClient = new KeyClient(vaultUrl, credential);
        
        await keyClient.createKey(name, keyType, {
            keySize: keySize,
            tags: description ? { description } : undefined
        });
        
        await loadKeysForKeyVault(currentKeyVault);
        hideAddKeyModal();
        showNotification('Key created successfully', 'success');
        
    } catch (error) {
        console.error('Error creating key:', error);
        showNotification('Failed to create key: ' + error.message, 'error');
    }
}

// Export functionality
async function exportData() {
    const format = document.getElementById('exportFormat').value;
    const type = document.getElementById('exportType').value;
    const includeValues = document.getElementById('includeValues').checked;
    
    if (!currentKeyVault) {
        showNotification('Please select a Key Vault first', 'error');
        return;
    }
    
    try {
        let data = {};
        
        if (type === 'secrets' || type === 'all') {
            data.secrets = allSecretsByVault.get(currentKeyVault.name) || [];
            if (!includeValues) {
                data.secrets = data.secrets.map(secret => ({
                    ...secret,
                    value: '[REDACTED]'
                }));
            }
        }
        
        if (type === 'keys' || type === 'all') {
            data.keys = allKeysByVault.get(currentKeyVault.name) || [];
        }
        
        let content = '';
        const filename = `${currentKeyVault.name}-${type}-${new Date().toISOString().split('T')[0]}`;
        
        if (format === 'json') {
            content = JSON.stringify(data, null, 2);
            downloadFile(content, `${filename}.json`, 'application/json');
        } else if (format === 'csv') {
            content = convertToCSV(data, type);
            downloadFile(content, `${filename}.csv`, 'text/csv');
        } else if (format === 'txt') {
            content = convertToText(data, type);
            downloadFile(content, `${filename}.txt`, 'text/plain');
        }
        
        hideExportModal();
        showNotification('Export completed successfully', 'success');
        
    } catch (error) {
        console.error('Error exporting data:', error);
        showNotification('Failed to export data: ' + error.message, 'error');
    }
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function convertToCSV(data, type) {
    let csv = '';
    if (type === 'secrets' || type === 'all') {
        csv += 'Name,Version,Created,Updated,Expires,Enabled,Value\n';
        data.secrets.forEach(secret => {
            csv += `"${secret.name}","${secret.version}","${secret.created}","${secret.updated}","${secret.expires}","${secret.enabled}","${secret.value}"\n`;
        });
    }
    if (type === 'keys' || type === 'all') {
        csv += '\nKey Name,Type,Size,Version,Created,Updated,Expires,Enabled\n';
        data.keys.forEach(key => {
            csv += `"${key.name}","${key.keyType}","${key.keySize}","${key.version}","${key.created}","${key.updated}","${key.expires}","${key.enabled}"\n`;
        });
    }
    return csv;
}

function convertToText(data, type) {
    let text = `Azure Key Vault Export\n`;
    text += `Generated: ${new Date().toISOString()}\n\n`;
    
    if (type === 'secrets' || type === 'all') {
        text += 'SECRETS:\n';
        text += '========\n';
        data.secrets.forEach(secret => {
            text += `Name: ${secret.name}\n`;
            text += `Version: ${secret.version}\n`;
            text += `Created: ${secret.created}\n`;
            text += `Updated: ${secret.updated}\n`;
            text += `Expires: ${secret.expires || 'Never'}\n`;
            text += `Enabled: ${secret.enabled}\n`;
            text += `Value: ${secret.value}\n\n`;
        });
    }
    
    if (type === 'keys' || type === 'all') {
        text += 'KEYS:\n';
        text += '=====\n';
        data.keys.forEach(key => {
            text += `Name: ${key.name}\n`;
            text += `Type: ${key.keyType}\n`;
            text += `Size: ${key.keySize}\n`;
            text += `Version: ${key.version}\n`;
            text += `Created: ${key.created}\n`;
            text += `Updated: ${key.updated}\n`;
            text += `Expires: ${key.expires || 'Never'}\n`;
            text += `Enabled: ${key.enabled}\n\n`;
        });
    }
    
    return text;
}

// Utility functions
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        const button = event.target.closest('button');
        const originalText = button.innerHTML;
        button.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => {
            button.innerHTML = originalText;
        }, 2000);
        showNotification('Copied to clipboard', 'success');
    });
}

function togglePasswordVisibility(secretName) {
    const secretValue = document.getElementById(`secret-value-${secretName}`);
    const icon = secretValue.querySelector('.toggle-password i');
    
    if (secretValue.classList.contains('hidden')) {
        secretValue.classList.remove('hidden');
        icon.className = 'fas fa-eye-slash';
    } else {
        secretValue.classList.add('hidden');
        icon.className = 'fas fa-eye';
    }
}

function deleteSecret(secretName) {
    if (!currentKeyVault) return;
    if (confirm(`Are you sure you want to delete the secret "${secretName}"?`)) {
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const secretClient = new SecretClient(vaultUrl, credential);
        
        secretClient.beginDeleteSecret(secretName).then(() => {
            loadSecretsForKeyVault(currentKeyVault);
            showNotification('Secret deleted successfully', 'success');
        }).catch(error => {
            console.error('Error deleting secret:', error);
            showNotification('Failed to delete secret: ' + error.message, 'error');
        });
    }
}

function deleteKey(keyName) {
    if (!currentKeyVault) return;
    if (confirm(`Are you sure you want to delete the key "${keyName}"?`)) {
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const keyClient = new KeyClient(vaultUrl, credential);
        
        keyClient.beginDeleteKey(keyName).then(() => {
            loadKeysForKeyVault(currentKeyVault);
            showNotification('Key deleted successfully', 'success');
        }).catch(error => {
            console.error('Error deleting key:', error);
            showNotification('Failed to delete key: ' + error.message, 'error');
        });
    }
}

// Create secret card
function createSecretCard(secret) {
    const card = document.createElement('div');
    card.className = 'secret-card';
    
    const createdDate = secret.created ? new Date(secret.created).toLocaleDateString() : 'N/A';
    const updatedDate = secret.updated ? new Date(secret.updated).toLocaleDateString() : 'N/A';
    const expiresDate = secret.expires ? new Date(secret.expires).toLocaleDateString() : 'Never';
    
    card.innerHTML = `
        <div class="secret-header">
            <div class="secret-name">${secret.name}</div>
            <div class="secret-actions">
                <button class="btn btn-secondary" onclick="copyToClipboard('${secret.value}')">
                    <i class="fas fa-copy"></i> Copy
                </button>
                <button class="btn btn-danger" onclick="deleteSecret('${secret.name}')">
                    <i class="fas fa-trash"></i> Delete
                </button>
            </div>
        </div>
        <div class="secret-info">
            <div class="info-item">
                <div class="info-label">Version</div>
                <div class="info-value">${secret.version}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Created</div>
                <div class="info-value">${createdDate}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Updated</div>
                <div class="info-value">${updatedDate}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Expires</div>
                <div class="info-value">${expiresDate}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Status</div>
                <div class="info-value">
                    <span class="status-indicator ${secret.enabled ? 'status-enabled' : 'status-disabled'}"></span>
                    ${secret.enabled ? 'Enabled' : 'Disabled'}
                </div>
            </div>
        </div>
        <div class="secret-value hidden" id="secret-value-${secret.name}">
            ${secret.value}
            <button class="toggle-password" onclick="togglePasswordVisibility('${secret.name}')">
                <i class="fas fa-eye"></i>
            </button>
        </div>
    `;
    
    return card;
}

// Create key card
function createKeyCard(key) {
    const card = document.createElement('div');
    card.className = 'key-card';
    
    const createdDate = key.created ? new Date(key.created).toLocaleDateString() : 'N/A';
    const updatedDate = key.updated ? new Date(key.updated).toLocaleDateString() : 'N/A';
    const expiresDate = key.expires ? new Date(key.expires).toLocaleDateString() : 'Never';
    
    card.innerHTML = `
        <div class="key-header">
            <div class="key-name">${key.name}</div>
            <div class="key-actions">
                <button class="btn btn-secondary" onclick="copyToClipboard('${key.name}')">
                    <i class="fas fa-copy"></i> Copy Name
                </button>
                <button class="btn btn-danger" onclick="deleteKey('${key.name}')">
                    <i class="fas fa-trash"></i> Delete
                </button>
            </div>
        </div>
        <div class="key-info">
            <div class="info-item">
                <div class="info-label">Type</div>
                <div class="info-value">
                    <span class="key-type-badge ${key.keyType.toLowerCase()}">${key.keyType}</span>
                </div>
            </div>
            <div class="info-item">
                <div class="info-label">Size</div>
                <div class="info-value">${key.keySize || 'N/A'}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Version</div>
                <div class="info-value">${key.version}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Created</div>
                <div class="info-value">${createdDate}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Updated</div>
                <div class="info-value">${updatedDate}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Expires</div>
                <div class="info-value">${expiresDate}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Status</div>
                <div class="info-value">
                    <span class="status-indicator ${key.enabled ? 'status-enabled' : 'status-disabled'}"></span>
                    ${key.enabled ? 'Enabled' : 'Disabled'}
                </div>
            </div>
        </div>
    `;
    
    return card;
}

// Make functions globally available for onclick handlers
window.copyToClipboard = copyToClipboard;
window.togglePasswordVisibility = togglePasswordVisibility;
window.deleteSecret = deleteSecret;
window.deleteKey = deleteKey;
window.bulkExport = bulkExport;
window.bulkDisable = bulkDisable;
window.bulkEnable = bulkEnable;
window.bulkDelete = bulkDelete;

function showBulkOperations() {
    if (!currentKeyVault) {
        showNotification('Please select a Key Vault first', 'error');
        return;
    }
    
    const items = currentTab === 'secrets' ? 
        (allSecretsByVault.get(currentKeyVault.name) || []) : 
        (allKeysByVault.get(currentKeyVault.name) || []);
    
    if (items.length === 0) {
        showNotification(`No ${currentTab} found for bulk operations`, 'warning');
        return;
    }
    
    const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
    const bulkActions = document.createElement('div');
    bulkActions.className = 'bulk-actions';
    bulkActions.innerHTML = `
        <span><strong>Bulk Operations for ${items.length} ${currentTab}:</strong></span>
        <button class="btn btn-secondary" onclick="bulkExport()">
            <i class="fas fa-download"></i> Export All
        </button>
        <button class="btn btn-warning" onclick="bulkDisable()">
            <i class="fas fa-pause"></i> Disable All
        </button>
        <button class="btn btn-success" onclick="bulkEnable()">
            <i class="fas fa-play"></i> Enable All
        </button>
        <button class="btn btn-danger" onclick="bulkDelete()">
            <i class="fas fa-trash"></i> Delete All
        </button>
    `;
    
    // Insert at the top of the container
    container.insertBefore(bulkActions, container.firstChild);
    
    showNotification(`Bulk operations panel added for ${items.length} ${currentTab}`, 'success');
}

// Bulk operation functions
function bulkExport() {
    const type = currentTab === 'secrets' ? 'secrets' : 'keys';
    document.getElementById('exportType').value = type;
    document.getElementById('exportFormat').value = 'json';
    document.getElementById('includeValues').checked = true;
    showExportModal();
}

function bulkDisable() {
    if (!confirm(`Are you sure you want to disable all ${currentTab} in ${currentKeyVault.name}?`)) return;
    showNotification('Bulk disable operation not implemented yet', 'warning');
}

function bulkEnable() {
    if (!confirm(`Are you sure you want to enable all ${currentTab} in ${currentKeyVault.name}?`)) return;
    showNotification('Bulk enable operation not implemented yet', 'warning');
}

function bulkDelete() {
    if (!confirm(`Are you sure you want to delete ALL ${currentTab} in ${currentKeyVault.name}? This action cannot be undone!`)) return;
    showNotification('Bulk delete operation not implemented yet', 'warning');
}

// Add performance indicator to UI
function addPerformanceIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'memoryIndicator';
    indicator.className = 'memory-usage show';
    indicator.textContent = 'Performance: Loading...';
    document.body.appendChild(indicator);
    
    // Update every 5 seconds
    setInterval(updatePerformanceMetrics, 5000);
} 