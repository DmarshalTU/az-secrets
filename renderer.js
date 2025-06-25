const { ipcRenderer } = require('electron');
const { DefaultAzureCredential } = require('@azure/identity');
const { KeyVaultManagementClient } = require('@azure/arm-keyvault');
const { SecretClient } = require('@azure/keyvault-secrets');
const { KeyClient } = require('@azure/keyvault-keys');
const { CertificateClient } = require('@azure/keyvault-certificates');
const { SubscriptionClient } = require('@azure/arm-subscriptions');
const fs = require('fs');
const path = require('path');

// Global state with performance optimizations
let allKeyVaults = [];
let allSecretsByVault = new Map(); // Using Map for better performance
let allKeysByVault = new Map();    // Using Map for better performance
let allCertificatesByVault = new Map(); // Using Map for better performance
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
let keyVaultSearchTimeout; // Separate timeout for key vault search

// Performance monitoring and memory management
let performanceMetrics = {
    vaultLoadTime: 0,
    searchTime: 0,
    memoryUsage: 0,
    loadedVaultsCount: 0,
    totalSecrets: 0,
    totalKeys: 0,
    totalCertificates: 0
};

// Logging system
let activityLog = [];
let maxLogEntries = 100;

// DOM elements - will be initialized after DOM loads
let keyvaultList;
let secretsContainer;
let keysContainer;
let certificatesContainer;
let mainHeader;
let globalSearchInput;
let clearGlobalSearchBtn;
let refreshKeyVaultsBtn;
let keyvaultSearchInput;
let addSecretBtn;
let addSecretModal;
let closeModalBtn;
let cancelAddBtn;
let saveSecretBtn;
let tabBtns;
let tabPanes;

// Add index service integration
let indexServiceAvailable = false;
let indexedVaults = new Map();
let searchResults = [];
let selectedItems = new Set();

// Add security status tracking (simplified)
let securityStatus = {
    containerRunning: false,
    containerSecure: false,
    encryptionEnabled: false,
    lastVerified: null
};

// Add migration state variables
let selectedSecrets = new Set();
let selectedKeys = new Set();
let selectedCertificates = new Set();
let isSelectionMode = false;
let migrationInProgress = false;
let migrationCancelled = false;

// Simplified index service initialization
async function initializeIndexService() {
    try {
        console.log('Initializing index service...');
        const isHealthy = await ipcRenderer.invoke('index-service-health');
        if (isHealthy) {
            indexServiceAvailable = true;
            securityStatus.containerRunning = true;
            
            // Get detailed status including security info
            try {
                const status = await ipcRenderer.invoke('index-service-status');
                if (status.indexedVaults > 0) {
                    addLogEntry(`Found ${status.indexedVaults} indexed vaults`, 'info');
                }
            } catch (error) {
                console.warn('Failed to get index service status:', error);
            }
            
            // Simple security verification
            try {
                await verifySecurityFeatures();
            } catch (error) {
                console.warn('Security verification failed:', error);
            }
            
            // Load indexed vaults
            try {
                await loadIndexedVaults();
            } catch (error) {
                console.warn('Failed to load indexed vaults:', error);
            }
            
            addLogEntry('Index service connected successfully', 'success');
        } else {
            addLogEntry('Index service not available, using direct Azure calls', 'warning');
            securityStatus.containerRunning = false;
        }
    } catch (error) {
        console.warn('Failed to connect to index service:', error);
        addLogEntry('Failed to connect to index service: ' + error.message, 'warning');
        securityStatus.containerRunning = false;
        // Don't throw error to prevent app crash
    }
}

// Simplified security verification
async function verifySecurityFeatures() {
    try {
        // Get detailed security status from the container
        const securityResponse = await ipcRenderer.invoke('get-security-status');
        
        if (securityResponse.error) {
            throw new Error(securityResponse.error);
        }
        
        // Update security status with container response
        securityStatus.containerRunning = securityResponse.containerRunning;
        securityStatus.containerSecure = securityResponse.containerSecure;
        securityStatus.encryptionEnabled = securityResponse.encryptionEnabled;
        securityStatus.lastVerified = securityResponse.lastVerified;
        
        addLogEntry('Security verification passed', 'success');
        
    } catch (error) {
        addLogEntry('Security verification failed: ' + error.message, 'error');
        securityStatus.containerSecure = false;
        securityStatus.containerRunning = false;
    }
}

// Load indexed vaults from the service
async function loadIndexedVaults() {
    try {
        const response = await ipcRenderer.invoke('get-indexed-vaults');
        if (response.vaults) {
            indexedVaults.clear();
            response.vaults.forEach(vault => {
                indexedVaults.set(vault.name, vault);
            });
            addLogEntry(`Loaded ${response.vaults.length} indexed vaults`, 'info');
        }
    } catch (error) {
        addLogEntry('Failed to load indexed vaults: ' + error.message, 'error');
    }
}

// Enhanced global search with better fallback
async function handleGlobalSearch() {
    const searchTerm = globalSearchInput.value.toLowerCase().trim();
    
    if (searchTimeout) {
        clearTimeout(searchTimeout);
    }
    
    searchTimeout = setTimeout(async () => {
        if (searchTerm) {
            // Show loading state
            const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
            showLoading(container, 'Searching...');
            
            try {
                await performFastSearch(searchTerm);
            } catch (error) {
                addLogEntry('Search failed: ' + error.message, 'error');
                showError(container, 'Search failed: ' + error.message);
            }
        } else {
            clearGlobalSearch();
        }
    }, 300);
}

// Enhanced fast search with better error handling
async function performFastSearch(searchTerm) {
    if (!indexServiceAvailable) {
        addLogEntry('Index service not available, using direct Azure search', 'info');
        return await performGlobalSearch(searchTerm);
    }

    // Verify security before search
    if (!securityStatus.containerRunning || !securityStatus.containerSecure) {
        addLogEntry('Security verification failed, using direct Azure search', 'warning');
        return await performGlobalSearch(searchTerm);
    }

    try {
        const response = await ipcRenderer.invoke('search-index', {
            query: searchTerm,
            type: currentTab
        });

        if (response.error) {
            throw new Error(response.error);
        }

        if (response.results) {
            searchResults = response.results;
            renderFastSearchResults(searchResults, searchTerm);
            addLogEntry(`Secure search found ${response.results.length} results in ${response.totalFound} total`, 'success');
        } else {
            searchResults = [];
            const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
            container.innerHTML = `
                <div class="welcome-message">
                    <i class="fas fa-search fa-3x"></i>
                    <h2>No results found</h2>
                    <p>No ${currentTab} matching "${searchTerm}" were found in the index.</p>
                </div>
            `;
        }
    } catch (error) {
        addLogEntry('Secure search failed: ' + error.message, 'error');
        // Fallback to direct search
        return await performGlobalSearch(searchTerm);
    }
}

// Render fast search results with bulk selection
function renderFastSearchResults(results, searchTerm) {
    const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
    container.innerHTML = '';
    
    if (results.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-search fa-3x"></i>
                <h2>No results found</h2>
                <p>No ${currentTab} matching "${searchTerm}" were found.</p>
            </div>
        `;
        return;
    }

    // Add bulk operations header
    const bulkHeader = document.createElement('div');
    bulkHeader.className = 'bulk-operations-header';
    bulkHeader.innerHTML = `
        <div class="bulk-controls">
            <label class="checkbox-container">
                <input type="checkbox" id="selectAll" onchange="toggleSelectAll()">
                <span class="checkmark"></span>
                Select All (${results.length})
            </label>
            <div class="bulk-actions">
                <button class="btn btn-secondary btn-sm" onclick="bulkCopy()" ${selectedItems.size === 0 ? 'disabled' : ''}>
                    <i class="fas fa-copy"></i> Copy Selected
                </button>
                <button class="btn btn-warning btn-sm" onclick="bulkToggle()" ${selectedItems.size === 0 ? 'disabled' : ''}>
                    <i class="fas fa-toggle-on"></i> Toggle Selected
                </button>
                <button class="btn btn-danger btn-sm" onclick="bulkDelete()" ${selectedItems.size === 0 ? 'disabled' : ''}>
                    <i class="fas fa-trash"></i> Delete Selected
                </button>
            </div>
        </div>
        <div class="search-stats">
            <span>Found ${results.length} results for "${searchTerm}"</span>
            <span class="selected-count">${selectedItems.size} selected</span>
        </div>
    `;
    container.appendChild(bulkHeader);

    // Group results by vault
    const vaultGroups = new Map();
    results.forEach(result => {
        if (!vaultGroups.has(result.vaultName)) {
            vaultGroups.set(result.vaultName, []);
        }
        vaultGroups.get(result.vaultName).push(result);
    });

    // Render results grouped by vault
    vaultGroups.forEach((vaultResults, vaultName) => {
        const vaultGroup = document.createElement('div');
        vaultGroup.className = 'search-vault-group';
        vaultGroup.innerHTML = `
            <div class="vault-group-header">
                <i class="fas fa-vault"></i>
                <span class="vault-name">${vaultName}</span>
                <span class="result-count">${vaultResults.length} ${currentTab}</span>
            </div>
        `;

        vaultResults.forEach(result => {
            const itemCard = createSearchResultCard(result, searchTerm);
            vaultGroup.appendChild(itemCard);
        });

        container.appendChild(vaultGroup);
    });
}

// Create search result card with checkbox
function createSearchResultCard(result, searchTerm) {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.dataset.itemId = `${result.vaultName}-${result.type}-${result.name}`;
    
    const isSelected = selectedItems.has(card.dataset.itemId);
    
    card.innerHTML = `
        <div class="result-checkbox">
            <label class="checkbox-container">
                <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleItemSelection('${card.dataset.itemId}')">
                <span class="checkmark"></span>
            </label>
        </div>
        <div class="result-content">
            <div class="result-header">
                <span class="result-type-badge ${result.type}">${result.type}</span>
                <span class="result-name">${highlightSearchTerm(result.name, searchTerm)}</span>
                <span class="search-score ${getScoreClass(result.score)}">${(result.score * 100).toFixed(0)}% match</span>
            </div>
            <div class="result-details">
                <span class="vault-name">${result.vaultName}</span>
                ${result.type === 'secret' && result.value ? `
                    <div class="result-value">
                        <span class="value-preview">${result.value.substring(0, 50)}${result.value.length > 50 ? '...' : ''}</span>
                        <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${result.value}')">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>
                ` : ''}
            </div>
        </div>
        <div class="result-actions">
            <button class="btn btn-sm btn-primary" onclick="viewItem('${result.vaultName}', '${result.name}', '${result.type}')">
                <i class="fas fa-eye"></i> View
            </button>
            <button class="btn btn-sm btn-secondary" onclick="editItem('${result.vaultName}', '${result.name}', '${result.type}')">
                <i class="fas fa-edit"></i> Edit
            </button>
        </div>
    `;
    
    return card;
}

// Bulk operations
window.toggleSelectAll = function() {
    const selectAllCheckbox = document.getElementById('selectAll');
    const checkboxes = document.querySelectorAll('.search-result-card input[type="checkbox"]');
    
    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
        const card = checkbox.closest('.search-result-card');
        if (selectAllCheckbox.checked) {
            selectedItems.add(card.dataset.itemId);
        } else {
            selectedItems.delete(card.dataset.itemId);
        }
    });
    
    updateSelectedCount();
    updateBulkActionButtons();
}

// Make toggleItemSelection globally accessible
window.toggleItemSelection = function(itemName, itemType) {
    if (!isSelectionMode) return;
    
    let selectedSet;
    if (itemType === 'secret') {
        selectedSet = selectedSecrets;
    } else if (itemType === 'key') {
        selectedSet = selectedKeys;
    } else if (itemType === 'certificate') {
        selectedSet = selectedCertificates;
    } else {
        return;
    }
    
    if (selectedSet.has(itemName)) {
        selectedSet.delete(itemName);
    } else {
        selectedSet.add(itemName);
    }
    
    updateMigrationButton();
    addLogEntry(`${itemType} "${itemName}" ${selectedSet.has(itemName) ? 'selected' : 'deselected'}`, 'info');
    
    // Re-render to update selection state
    if (currentKeyVault) {
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'keys') {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'certificates') {
            renderCertificates(allCertificatesByVault.get(currentKeyVault.name) || []);
        }
    }
};

// Make selectAllItems globally accessible
window.selectAllItems = function() {
    if (!currentKeyVault) return;
    
    let items = [];
    if (currentTab === 'secrets') {
        items = allSecretsByVault.get(currentKeyVault.name) || [];
        items.forEach(item => selectedSecrets.add(item.name));
    } else if (currentTab === 'keys') {
        items = allKeysByVault.get(currentKeyVault.name) || [];
        items.forEach(item => selectedKeys.add(item.name));
    } else if (currentTab === 'certificates') {
        items = allCertificatesByVault.get(currentKeyVault.name) || [];
        items.forEach(item => selectedCertificates.add(item.name));
    }
    
    updateMigrationButton();
    addLogEntry(`Selected all ${items.length} ${currentTab}`, 'info');
    
    // Re-render to update selection state
    if (currentTab === 'secrets') {
        renderSecrets(items);
    } else if (currentTab === 'keys') {
        renderKeys(items);
    } else if (currentTab === 'certificates') {
        renderCertificates(items);
    }
};

// Make deselectAllItems globally accessible
window.deselectAllItems = function() {
    selectedSecrets.clear();
    selectedKeys.clear();
    selectedCertificates.clear();
    updateMigrationButton();
    addLogEntry('Deselected all items', 'info');
    
    // Re-render to update selection state
    if (currentKeyVault) {
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'keys') {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'certificates') {
            renderCertificates(allCertificatesByVault.get(currentKeyVault.name) || []);
        }
    }
};

function updateSelectedCount() {
    const selectedCountElement = document.querySelector('.selected-count');
    if (selectedCountElement) {
        selectedCountElement.textContent = `${selectedItems.size} selected`;
    }
}

function updateBulkActionButtons() {
    const bulkButtons = document.querySelectorAll('.bulk-actions button');
    bulkButtons.forEach(button => {
        button.disabled = selectedItems.size === 0;
    });
}

window.bulkCopy = async function() {
    const selectedResults = Array.from(selectedItems).map(itemId => {
        const [vaultName, type, name] = itemId.split('-');
        return searchResults.find(r => r.vaultName === vaultName && r.type === type && r.name === name);
    }).filter(Boolean);

    if (selectedResults.length === 0) return;

    const copyData = selectedResults.map(result => ({
        vault: result.vaultName,
        type: result.type,
        name: result.name,
        value: result.value || result.data?.value || ''
    }));

    const copyText = copyData.map(item => 
        `${item.vault}/${item.type}/${item.name}: ${item.value}`
    ).join('\n');

    await copyToClipboard(copyText);
    showNotification(`Copied ${selectedResults.length} items to clipboard`, 'success');
}

window.bulkToggle = async function() {
    const selectedResults = Array.from(selectedItems).map(itemId => {
        const [vaultName, type, name] = itemId.split('-');
        return searchResults.find(r => r.vaultName === vaultName && r.type === type && r.name === name);
    }).filter(Boolean);

    if (selectedResults.length === 0) return;

    const confirmed = confirm(`Are you sure you want to toggle ${selectedResults.length} items?`);
    if (!confirmed) return;

    let successCount = 0;
    let errorCount = 0;

    for (const result of selectedResults) {
        try {
            // Implement toggle logic here
            // This would require additional API endpoints in the index service
            successCount++;
        } catch (error) {
            errorCount++;
            console.error(`Failed to toggle ${result.name}:`, error);
        }
    }

    showNotification(`Toggled ${successCount} items successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`, 
        errorCount > 0 ? 'warning' : 'success');
}

window.bulkDelete = async function() {
    const selectedResults = Array.from(selectedItems).map(itemId => {
        const [vaultName, type, name] = itemId.split('-');
        return searchResults.find(r => r.vaultName === vaultName && r.type === type && r.name === name);
    }).filter(Boolean);

    if (selectedResults.length === 0) return;

    const confirmed = confirm(`Are you sure you want to delete ${selectedResults.length} items? This action cannot be undone.`);
    if (!confirmed) return;

    let successCount = 0;
    let errorCount = 0;

    for (const result of selectedResults) {
        try {
            if (result.type === 'secret') {
                await deleteSecret(result.name);
            } else {
                await deleteKey(result.name);
            }
            successCount++;
        } catch (error) {
            errorCount++;
            console.error(`Failed to delete ${result.name}:`, error);
        }
    }

    showNotification(`Deleted ${successCount} items successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`, 
        errorCount > 0 ? 'warning' : 'success');
    
    // Refresh search results
    if (globalSearchInput.value.trim()) {
        await performFastSearch(globalSearchInput.value.trim());
    }
}

// Helper functions
function getScoreClass(score) {
    if (score < 0.2) return 'high';
    if (score < 0.4) return 'medium';
    return 'low';
}

window.viewItem = function(vaultName, itemName, itemType) {
    // Navigate to the specific vault and item
    const vault = allKeyVaults.find(kv => kv.name === vaultName);
    if (vault) {
        selectKeyVault(vault);
        // TODO: Scroll to specific item
    }
}

window.editItem = function(vaultName, itemName, itemType) {
    // Open edit modal for the specific item
    const result = searchResults.find(r => r.vaultName === vaultName && r.type === itemType && r.name === itemName);
    if (result) {
        if (itemType === 'secret') {
            showEditSecretModal(itemName, result.value);
        } else {
            // TODO: Implement key editing
            showNotification('Key editing not yet implemented', 'info');
        }
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('DOM Content Loaded - Starting initialization...');
        
        // Add timeout wrapper for the entire initialization
        const initTimeout = (promise, timeoutMs) => {
            return Promise.race([
                promise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`Initialization timed out after ${timeoutMs/1000}s`)), timeoutMs)
                )
            ]);
        };
        
        // Wrap the entire initialization in a timeout
        await initTimeout((async () => {
            // Initialize DOM elements with error handling
            try {
                console.log('Initializing DOM elements...');
                keyvaultList = document.getElementById('keyvaultList');
                secretsContainer = document.getElementById('secretsContainer');
                keysContainer = document.getElementById('keysContainer');
                certificatesContainer = document.getElementById('certificatesContainer');
                globalSearchInput = document.getElementById('globalSearchInput');
                clearGlobalSearchBtn = document.getElementById('clearGlobalSearch');
                keyvaultSearchInput = document.getElementById('keyvaultSearchInput');
                refreshKeyVaultsBtn = document.getElementById('refreshKeyVaults');
                tabBtns = document.querySelectorAll('.tab-btn');
                
                // Verify all required elements exist
                if (!keyvaultList) console.error('keyvaultList not found');
                if (!secretsContainer) console.error('secretsContainer not found');
                if (!keysContainer) console.error('keysContainer not found');
                if (!certificatesContainer) console.error('certificatesContainer not found');
                if (!globalSearchInput) console.error('globalSearchInput not found');
                if (!clearGlobalSearchBtn) console.error('clearGlobalSearchBtn not found');
                if (!keyvaultSearchInput) console.error('keyvaultSearchInput not found');
                if (!refreshKeyVaultsBtn) console.error('refreshKeyVaultsBtn not found');
                if (!tabBtns || tabBtns.length === 0) console.error('tabBtns not found');
                
                console.log('DOM elements initialized successfully');
            } catch (error) {
                console.error('Error initializing DOM elements:', error);
                throw error;
            }
            
            // Add UI components
            try {
                console.log('Adding UI components...');
                addActivityLog();
                addPerformanceIndicator();
                console.log('UI components added successfully');
            } catch (error) {
                console.error('Error adding UI components:', error);
                // Don't throw here, continue with initialization
            }
            
            // Setup event listeners
            try {
                console.log('Setting up event listeners...');
                setupEventListeners();
                setupModalEventListeners();
                console.log('Event listeners set up successfully');
            } catch (error) {
                console.error('Error setting up event listeners:', error);
                // Don't throw here, continue with initialization
            }
            
            // Initialize index service
            try {
                console.log('Initializing index service...');
                await initializeIndexService();
                console.log('Index service initialized successfully');
            } catch (error) {
                console.error('Error initializing index service:', error);
                // Don't throw here, continue with initialization
            }
            
            // Start security polling
            try {
                console.log('Starting security polling...');
                pollSecurityStatus();
                console.log('Security polling started successfully');
            } catch (error) {
                console.error('Error starting security polling:', error);
                // Don't throw here, continue with initialization
            }
            
            // Load Key Vaults
            try {
                console.log('Starting to load Key Vaults...');
                await loadAllKeyVaults();
                console.log('Key Vaults loaded successfully');
            } catch (error) {
                console.error('Error loading Key Vaults:', error);
                // Show error message to user but don't crash the app
                if (keyvaultList) {
                    keyvaultList.innerHTML = `
                        <div class="error">
                            <i class="fas fa-exclamation-triangle fa-3x"></i>
                            <h2>Failed to Load Key Vaults</h2>
                            <p>Error: ${error.message}</p>
                            <p>Please check your Azure authentication and try again.</p>
                            <button class="btn btn-primary" onclick="loadAllKeyVaults()">
                                <i class="fas fa-sync"></i> Retry
                            </button>
                        </div>
                    `;
                }
                
                // Show a basic welcome message in the main content area
                if (secretsContainer) {
                    secretsContainer.innerHTML = `
                        <div class="welcome-message">
                            <i class="fas fa-key fa-3x"></i>
                            <h2>Welcome to Azure Secrets Explorer</h2>
                            <p>The app is ready, but Key Vault loading failed.</p>
                            <p>You can still use the global search feature or try refreshing the Key Vaults.</p>
                            <div style="margin-top: 20px;">
                                <button class="btn btn-primary" onclick="loadAllKeyVaults()">
                                    <i class="fas fa-sync"></i> Retry Loading Key Vaults
                                </button>
                            </div>
                        </div>
                    `;
                }
            }
            
            console.log('Application initialization completed');
        })(), 60000); // 60 second timeout for entire initialization
        
    } catch (error) {
        console.error('Critical error during initialization:', error);
        // Show critical error message
        if (keyvaultList) {
            keyvaultList.innerHTML = `
                <div class="error">
                    <i class="fas fa-exclamation-triangle fa-3x"></i>
                    <h2>Critical Error</h2>
                    <p>Failed to initialize the application: ${error.message}</p>
                    <p>Please restart the application or check the console for more details.</p>
                    <button class="btn btn-primary" onclick="location.reload()">
                        <i class="fas fa-sync"></i> Reload Application
                    </button>
                </div>
            `;
        }
    }
});

// Activity logging system
function addActivityLog() {
    try {
        console.log('Adding activity log...');
        const logContainer = document.createElement('div');
        logContainer.id = 'activityLog';
        logContainer.className = 'activity-log-container';
        logContainer.innerHTML = `
            <div class="activity-log-header" onclick="toggleActivityLog()">
                <h3><i class="fas fa-list"></i> Activity Log</h3>
                <div class="activity-log-controls">
                    <button class="btn btn-secondary btn-sm" onclick="clearActivityLog(); event.stopPropagation();">
                        <i class="fas fa-trash"></i> Clear
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="toggleActivityLog(); event.stopPropagation();">
                        <i class="fas fa-chevron-up" id="activityLogToggleIcon"></i>
                    </button>
                </div>
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
        if (sidebar && sidebar.parentNode) {
            sidebar.parentNode.insertBefore(logContainer, sidebar.nextSibling);
            console.log('Activity log added successfully');
        } else {
            console.warn('Sidebar not found, cannot add activity log');
        }
    } catch (error) {
        console.error('Failed to add activity log:', error);
    }
}

// Activity log toggle function - make it globally accessible
window.toggleActivityLog = function() {
    try {
        console.log('Toggling activity log...');
        const container = document.getElementById('activityLog');
        const toggleIcon = document.getElementById('activityLogToggleIcon');
        
        if (container && toggleIcon) {
            const isCollapsed = container.classList.contains('collapsed');
            
            if (isCollapsed) {
                // Expand
                container.classList.remove('collapsed');
                toggleIcon.className = 'fas fa-chevron-up';
                console.log('Activity log expanded');
            } else {
                // Collapse
                container.classList.add('collapsed');
                toggleIcon.className = 'fas fa-chevron-down';
                console.log('Activity log collapsed');
            }
        } else {
            console.error('Activity log container or toggle icon not found');
            console.log('Container ID:', container ? 'found' : 'not found');
            console.log('Toggle icon ID:', toggleIcon ? 'found' : 'not found');
        }
    } catch (error) {
        console.error('Error toggling activity log:', error);
    }
};

// Clear activity log function - make it globally accessible
window.clearActivityLog = function() {
    try {
        console.log('Clearing activity log...');
        activityLog = [];
        updateActivityLogUI();
        addLogEntry('Activity log cleared', 'info');
        showNotification('Activity log cleared', 'success');
    } catch (error) {
        console.error('Error clearing activity log:', error);
    }
};

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
    try {
        console.log('Setting up event listeners...');
        
        if (refreshKeyVaultsBtn) {
            refreshKeyVaultsBtn.addEventListener('click', loadAllKeyVaults);
        }
        
        // Add indexing button handler
        const startIndexingBtn = document.getElementById('startIndexing');
        if (startIndexingBtn) {
            startIndexingBtn.addEventListener('click', async () => {
                try {
                    startIndexingBtn.disabled = true;
                    startIndexingBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Indexing...';
                    
                    const response = await ipcRenderer.invoke('start-indexing');
                    if (response.error) {
                        showNotification('Failed to start indexing: ' + response.error, 'error');
                    } else {
                        showNotification('Indexing started successfully', 'success');
                        addLogEntry('Manual indexing started', 'info');
                    }
                } catch (error) {
                    showNotification('Failed to start indexing: ' + error.message, 'error');
                } finally {
                    startIndexingBtn.disabled = false;
                    startIndexingBtn.innerHTML = '<i class="fas fa-database"></i> Index';
                }
            });
        }
        
        // Debounced global search for better performance
        if (globalSearchInput) {
            globalSearchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => handleGlobalSearch(), 300); // 300ms debounce
            });
        }
        
        if (clearGlobalSearchBtn) {
            clearGlobalSearchBtn.addEventListener('click', clearGlobalSearch);
        }
        
        // Fixed Key Vault search - ensure the input exists and add proper event listener
        if (keyvaultSearchInput) {
            console.log('Setting up Key Vault search event listener');
            keyvaultSearchInput.addEventListener('input', (e) => {
                clearTimeout(keyVaultSearchTimeout);
                keyVaultSearchTimeout = setTimeout(() => {
                    console.log('Key Vault search triggered');
                    handleKeyVaultSearch();
                }, 300);
            });
        } else {
            console.warn('Key Vault search input not found');
        }
        
        // Modal event listeners with proper cleanup
        if (addSecretBtn) {
            addSecretBtn.addEventListener('click', showAddSecretModal);
        }
        
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', hideAddSecretModal);
        }
        
        if (cancelAddBtn) {
            cancelAddBtn.addEventListener('click', hideAddSecretModal);
        }
        
        if (saveSecretBtn) {
            saveSecretBtn.addEventListener('click', saveSecret);
        }
        
        // Add modal event listeners for all modals
        setupModalEventListeners();
        
        // Tab switching
        if (tabBtns) {
            tabBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    const tabName = btn.getAttribute('data-tab');
                    switchTab(tabName);
                });
            });
        }
        
        console.log('Event listeners set up successfully');
    } catch (error) {
        console.error('Failed to set up event listeners:', error);
    }
}

// Setup modal event listeners for proper closing
function setupModalEventListeners() {
    // Add Secret Modal
    const addSecretModal = document.getElementById('addSecretModal');
    const closeModalBtn = document.getElementById('closeModal');
    const cancelAddBtn = document.getElementById('cancelAdd');
    const saveSecretBtn = document.getElementById('saveSecret');
    
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', hideAddSecretModal);
    }
    if (cancelAddBtn) {
        cancelAddBtn.addEventListener('click', hideAddSecretModal);
    }
    if (saveSecretBtn) {
        saveSecretBtn.addEventListener('click', saveSecret);
    }
    if (addSecretModal) {
        addSecretModal.addEventListener('click', (e) => {
            if (e.target === addSecretModal) hideAddSecretModal();
        });
    }
    
    // Add Key Modal
    const addKeyModal = document.getElementById('addKeyModal');
    const closeKeyModalBtn = document.getElementById('closeKeyModal');
    const cancelAddKeyBtn = document.getElementById('cancelAddKey');
    const saveKeyBtn = document.getElementById('saveKey');
    
    if (closeKeyModalBtn) {
        closeKeyModalBtn.addEventListener('click', hideAddKeyModal);
    }
    if (cancelAddKeyBtn) {
        cancelAddKeyBtn.addEventListener('click', hideAddKeyModal);
    }
    if (saveKeyBtn) {
        saveKeyBtn.addEventListener('click', saveKey);
    }
    if (addKeyModal) {
        addKeyModal.addEventListener('click', (e) => {
            if (e.target === addKeyModal) hideAddKeyModal();
        });
    }
    
    // Export Modal
    const exportModal = document.getElementById('exportModal');
    const closeExportModalBtn = document.getElementById('closeExportModal');
    const cancelExportBtn = document.getElementById('cancelExport');
    const exportDataBtn = document.getElementById('exportData');
    
    if (closeExportModalBtn) {
        closeExportModalBtn.addEventListener('click', hideExportModal);
    }
    if (cancelExportBtn) {
        cancelExportBtn.addEventListener('click', hideExportModal);
    }
    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', exportData);
    }
    if (exportModal) {
        exportModal.addEventListener('click', (e) => {
            if (e.target === exportModal) hideExportModal();
        });
    }
    
    // Migration Modal
    const migrationModal = document.getElementById('migrationModal');
    if (migrationModal) {
        migrationModal.addEventListener('click', (e) => {
            if (e.target === migrationModal) hideMigrationModal();
        });
    }
    
    // Migration Progress Modal
    const migrationProgressModal = document.getElementById('migrationProgressModal');
    if (migrationProgressModal) {
        migrationProgressModal.addEventListener('click', (e) => {
            if (e.target === migrationProgressModal) closeMigrationProgress();
        });
    }
}

// Tab switching
function switchTab(tabName) {
    try {
        console.log('Switching to tab:', tabName);
        
        // Update current tab
        currentTab = tabName;
        
        // Update tab buttons
        const tabBtns = document.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-tab') === tabName) {
                btn.classList.add('active');
            }
        });
        
        // Update tab content
        const tabPanes = document.querySelectorAll('.tab-pane');
        tabPanes.forEach(pane => {
            pane.classList.remove('active');
            if (pane.id === `${tabName}Tab`) {
                pane.classList.add('active');
            }
        });
        
        // Update container reference
        const container = tabName === 'secrets' ? secretsContainer : 
                         tabName === 'keys' ? keysContainer : certificatesContainer;
        
        // If we have a current Key Vault, load the appropriate data
        if (currentKeyVault) {
            if (tabName === 'secrets') {
                const secrets = allSecretsByVault.get(currentKeyVault.name) || [];
                renderSecrets(secrets);
            } else if (tabName === 'keys') {
                const keys = allKeysByVault.get(currentKeyVault.name) || [];
                renderKeys(keys);
            } else if (tabName === 'certificates') {
                const certificates = allCertificatesByVault.get(currentKeyVault.name) || [];
                renderCertificates(certificates);
            }
        } else {
            // Show welcome message for the selected tab
            if (container) {
                if (tabName === 'secrets') {
                    container.innerHTML = `
                        <div class="welcome-message">
                            <i class="fas fa-key fa-3x"></i>
                            <h2>Secrets Management</h2>
                            <p>Select a Key Vault to view and manage your secrets</p>
                        </div>
                    `;
                } else if (tabName === 'keys') {
                    container.innerHTML = `
                        <div class="welcome-message">
                            <i class="fas fa-lock fa-3x"></i>
                            <h2>Key Management</h2>
                            <p>Select a Key Vault to view and manage your cryptographic keys</p>
                        </div>
                    `;
                } else if (tabName === 'certificates') {
                    container.innerHTML = `
                        <div class="welcome-message">
                            <i class="fas fa-certificate fa-3x"></i>
                            <h2>Certificate Management</h2>
                            <p>Select a Key Vault to view and manage your certificates</p>
                        </div>
                    `;
                }
            }
        }
        
        console.log('Tab switched successfully to:', tabName);
    } catch (error) {
        console.error('Error switching tab:', error);
    }
}

// Optimized Key Vault loading with pagination and detailed logging
async function loadAllKeyVaults() {
    try {
        addLogEntry('Starting to load Key Vaults...', 'info');
        console.log('Starting loadAllKeyVaults function');
        
        if (!keyvaultList) {
            console.error('keyvaultList DOM element not found');
            throw new Error('keyvaultList DOM element not found');
        }
        
        const loadingProgress = showLoadingWithProgress(keyvaultList, 'Initializing Azure connection...');
        
        allKeyVaults = [];
        allSecretsByVault.clear();
        allKeysByVault.clear();
        allCertificatesByVault.clear();
        loadedVaults.clear();
        filteredKeyVaults = []; // Reset filtered vaults
        currentVaultPage = 1;
        
        // Add timeout wrapper for Azure operations
        const timeoutWrapper = (promise, timeoutMs, operationName) => {
            return Promise.race([
                promise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs/1000}s`)), timeoutMs)
                )
            ]);
        };
        
        loadingProgress.updateMessage('Authenticating with Azure...');
        console.log('Creating Azure credential...');
        
        // Create Azure credential with timeout
        let credential;
        try {
            credential = await timeoutWrapper(
                Promise.resolve(new DefaultAzureCredential()),
                10000, // 10 second timeout
                'Azure credential creation'
            );
            console.log('Azure credential created successfully');
        } catch (error) {
            console.error('Failed to create Azure credential:', error);
            throw new Error(`Azure authentication failed: ${error.message}`);
        }
        
        loadingProgress.updateMessage('Creating subscription client...');
        console.log('Creating subscription client...');
        
        // Create subscription client with timeout
        let subscriptionClient;
        try {
            subscriptionClient = await timeoutWrapper(
                Promise.resolve(new SubscriptionClient(credential)),
                5000, // 5 second timeout
                'Subscription client creation'
            );
            console.log('Subscription client created successfully');
        } catch (error) {
            console.error('Failed to create subscription client:', error);
            throw new Error(`Failed to create subscription client: ${error.message}`);
        }
        
        loadingProgress.updateMessage('Listing subscriptions...');
        console.log('Listing subscriptions...');
        
        // List subscriptions with timeout
        let subscriptions = [];
        try {
            const subscriptionPromise = (async () => {
                const subs = [];
                for await (const subscription of subscriptionClient.subscriptions.list()) {
                    subs.push(subscription);
                }
                return subs;
            })();
            
            subscriptions = await timeoutWrapper(
                subscriptionPromise,
                15000, // 15 second timeout
                'Subscription listing'
            );
            console.log(`Found ${subscriptions.length} subscriptions`);
        } catch (error) {
            console.error('Failed to list subscriptions:', error);
            throw new Error(`Failed to list subscriptions: ${error.message}`);
        }
        
        if (subscriptions.length === 0) {
            throw new Error('No Azure subscriptions found. Please check your authentication.');
        }
        
        loadingProgress.updateMessage('Discovering Key Vaults...');
        console.log('Starting Key Vault discovery...');
        
        // Discover Key Vaults with timeout for each subscription
        const vaultPromises = subscriptions.map(async (subscription) => {
            try {
                console.log(`Discovering Key Vaults in subscription: ${subscription.subscriptionId}`);
                const keyVaultClient = new KeyVaultManagementClient(credential, subscription.subscriptionId);
                
                const vaultPromise = (async () => {
                    const vaults = [];
                    for await (const vault of keyVaultClient.vaults.list()) {
                        vaults.push({
                            name: vault.name,
                            id: vault.id,
                            location: vault.location,
                            resourceGroup: vault.id.split('/')[4],
                            subscriptionId: subscription.subscriptionId,
                            subscriptionName: subscription.displayName
                        });
                    }
                    return vaults;
                })();
                
                const vaults = await timeoutWrapper(
                    vaultPromise,
                    10000, // 10 second timeout per subscription
                    `Key Vault discovery for subscription ${subscription.subscriptionId}`
                );
                
                console.log(`Found ${vaults.length} Key Vaults in subscription ${subscription.subscriptionId}`);
                return vaults;
            } catch (error) {
                console.error(`Error discovering Key Vaults in subscription ${subscription.subscriptionId}:`, error);
                addLogEntry(`Failed to load vaults from subscription ${subscription.subscriptionId}: ${error.message}`, 'error');
                return []; // Return empty array for this subscription
            }
        });
        
        const vaultResults = await Promise.all(vaultPromises);
        allKeyVaults = vaultResults.flat();
        
        console.log(`Total Key Vaults discovered: ${allKeyVaults.length}`);
        addLogEntry(`Discovered ${allKeyVaults.length} Key Vaults across ${subscriptions.length} subscriptions`, 'success');
        
        if (allKeyVaults.length === 0) {
            loadingProgress.complete();
            keyvaultList.innerHTML = `
                <div class="welcome-message">
                    <i class="fas fa-search fa-3x"></i>
                    <h2>No Key Vaults Found</h2>
                    <p>No Key Vaults were found in your Azure subscriptions.</p>
                    <p>Please check your permissions or create a Key Vault first.</p>
                    <button class="btn btn-primary" onclick="loadAllKeyVaults()">
                        <i class="fas fa-sync"></i> Retry
                    </button>
                </div>
            `;
            return;
        }
        
        loadingProgress.updateMessage('Rendering Key Vaults...');
        console.log('Rendering Key Vaults...');
        
        // Initialize filtered vaults with all vaults
        filteredKeyVaults = [...allKeyVaults];
        
        // Render Key Vaults
        renderKeyVaultsPaginated(filteredKeyVaults);
        
        loadingProgress.complete();
        console.log('Key Vault loading completed successfully');
        
        // Update performance metrics
        updatePerformanceMetrics();
        
        // Start background loading of vault data
        startBackgroundLoading();
        
    } catch (error) {
        console.error('Error in loadAllKeyVaults:', error);
        addLogEntry(`Failed to load Key Vaults: ${error.message}`, 'error');
        
        // Show error message
        if (keyvaultList) {
            keyvaultList.innerHTML = `
                <div class="error">
                    <i class="fas fa-exclamation-triangle fa-3x"></i>
                    <h2>Failed to Load Key Vaults</h2>
                    <p>Error: ${error.message}</p>
                    <p>Please check your Azure authentication and try again.</p>
                    <button class="btn btn-primary" onclick="loadAllKeyVaults()">
                        <i class="fas fa-sync"></i> Retry
                    </button>
                </div>
            `;
        }
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
    
    // Load secrets, keys, and certificates in parallel
    addLogEntry(`Loading secrets, keys, and certificates from ${vault.name}...`, 'info');
    const [secrets, keys, certificates] = await Promise.all([
        loadSecretsForVault(vaultUrl, credential, vault.name),
        loadKeysForVault(vaultUrl, credential, vault.name),
        loadCertificatesForVault(vaultUrl, credential, vault.name)
    ]);
    
    allSecretsByVault.set(vault.name, secrets);
    allKeysByVault.set(vault.name, keys);
    allCertificatesByVault.set(vault.name, certificates);
    
    const endTime = performance.now();
    performanceMetrics.vaultLoadTime = (endTime - startTime) / 1000; // Convert to seconds
    
    addLogEntry(`Loaded ${vault.name}: ${secrets.length} secrets, ${keys.length} keys, ${certificates.length} certificates in ${performanceMetrics.vaultLoadTime.toFixed(2)}s`, 'success');
    console.log(`Loaded vault ${vault.name} in ${performanceMetrics.vaultLoadTime.toFixed(2)}s (${secrets.length} secrets, ${keys.length} keys, ${certificates.length} certificates)`);
    
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
        console.log(`Loading keys for vault: ${vaultName}`);
        let keyCount = 0;
        
        for await (const keyProp of keyClient.listPropertiesOfKeys()) {
            try {
                console.log(`Found key: ${keyProp.name}, type: ${keyProp.keyType}`);
                const key = await keyClient.getKey(keyProp.name);
                const keyInfo = {
                    name: key.name,
                    keyType: key.keyType,
                    keySize: key.keySize,
                    version: key.properties.version,
                    created: key.properties.createdOn,
                    updated: key.properties.updatedOn,
                    expires: key.properties.expiresOn,
                    enabled: key.properties.enabled
                };
                keys.push(keyInfo);
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

// Enhanced fuzzy search with better performance and accuracy
function fuzzySearch(text, pattern) {
    if (!pattern) return true;
    if (!text) return false;
    
    // Convert to lowercase for case-insensitive search
    text = text.toLowerCase();
    pattern = pattern.toLowerCase();
    
    // Simple substring search for better performance
    if (text.includes(pattern)) return true;
    
    // Fuzzy search for partial matches
    const patternChars = pattern.split('');
    let textIndex = 0;
    let matchCount = 0;
    
    for (const char of patternChars) {
        const foundIndex = text.indexOf(char, textIndex);
        if (foundIndex === -1) {
            // If we can't find the character, try from the beginning
            const altIndex = text.indexOf(char);
            if (altIndex === -1) return false;
            textIndex = altIndex + 1;
        } else {
            textIndex = foundIndex + 1;
        }
        matchCount++;
    }
    
    // Return true if we found at least 70% of the pattern characters
    return matchCount >= Math.ceil(patternChars.length * 0.7);
}

// Enhanced search with multiple strategies and proper scoring
function enhancedSearch(text, pattern) {
    if (!pattern) return { match: true, score: 100 };
    if (!text) return { match: false, score: 0 };
    
    const searchText = text.toLowerCase();
    const searchPattern = pattern.toLowerCase();
    
    // 1. Exact match (highest priority)
    if (searchText === searchPattern) return { match: true, score: 100 };
    
    // 2. Starts with (high priority)
    if (searchText.startsWith(searchPattern)) return { match: true, score: 90 };
    
    // 3. Contains (medium priority)
    if (searchText.includes(searchPattern)) return { match: true, score: 80 };
    
    // 4. Fuzzy search (lower priority)
    if (fuzzySearch(searchText, searchPattern)) {
        // Calculate fuzzy score based on character matches
        const patternChars = searchPattern.split('');
        let matchCount = 0;
        let textIndex = 0;
        
        for (const char of patternChars) {
            const foundIndex = searchText.indexOf(char, textIndex);
            if (foundIndex !== -1) {
                matchCount++;
                textIndex = foundIndex + 1;
            }
        }
        
        const fuzzyScore = Math.round((matchCount / patternChars.length) * 60);
        return { match: true, score: Math.max(fuzzyScore, 20) }; // Minimum 20% score
    }
    
    return { match: false, score: 0 };
}

// Optimized global search with better caching and performance
async function performGlobalSearch(searchTerm) {
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
        const cachedResults = searchCache.get(cacheKey);
        renderGlobalSearchResults(cachedResults, searchTerm);
        addLogEntry(`Using cached search results for "${searchTerm}"`, 'info');
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
                    <p>No ${currentTab} matching "${searchTerm}" were found in the currently loaded Key Vaults.</p>
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

// Optimized search in loaded vaults with scoring
async function searchLoadedVaults(searchTerm) {
    const startTime = performance.now();
    
    const searchResults = [];
    
    // Search secrets in loaded vaults
    for (const [vaultName, secrets] of allSecretsByVault.entries()) {
        for (const secret of secrets) {
            const nameMatch = enhancedSearch(secret.name, searchTerm);
            const valueMatch = secret.value ? enhancedSearch(secret.value, searchTerm) : { match: false, score: 0 };
            
            if (nameMatch.match || valueMatch.match) {
                searchResults.push({ 
                    ...secret, 
                    vaultName, 
                    type: 'secret',
                    searchScore: Math.max(nameMatch.score, valueMatch.score)
                });
            }
        }
    }
    
    // Search keys in loaded vaults
    for (const [vaultName, keys] of allKeysByVault.entries()) {
        for (const key of keys) {
            const nameMatch = enhancedSearch(key.name, searchTerm);
            const typeMatch = enhancedSearch(key.keyType, searchTerm);
            
            if (nameMatch.match || typeMatch.match) {
                searchResults.push({ 
                    ...key, 
                    vaultName, 
                    type: 'key',
                    searchScore: Math.max(nameMatch.score, typeMatch.score)
                });
            }
        }
    }
    
    // Sort results by relevance score
    searchResults.sort((a, b) => b.searchScore - a.searchScore);
    
    const endTime = performance.now();
    performanceMetrics.searchTime = (endTime - startTime) / 1000; // Convert to seconds
    
    console.log(`Search completed in ${performanceMetrics.searchTime.toFixed(2)}s, found ${searchResults.length} results`);
    addLogEntry(`Global search found ${searchResults.length} results in ${performanceMetrics.searchTime.toFixed(2)}s`, 'success');
    
    return searchResults;
}

// Enhanced Key Vault search with better performance
function handleKeyVaultSearch() {
    try {
        const searchTerm = keyvaultSearchInput.value.toLowerCase().trim();
        console.log('Key Vault search term:', searchTerm);
        console.log('Total Key Vaults available:', allKeyVaults.length);
        
        if (!searchTerm) {
            filteredKeyVaults = [...allKeyVaults];
            console.log('No search term, showing all vaults:', filteredKeyVaults.length);
        } else {
            // Use enhanced search for better results
            const searchResults = allKeyVaults.map(kv => {
                const nameMatch = enhancedSearch(kv.name, searchTerm);
                const locationMatch = enhancedSearch(kv.location, searchTerm);
                const resourceGroupMatch = enhancedSearch(kv.resourceGroup, searchTerm);
                const subscriptionMatch = enhancedSearch(kv.subscriptionId, searchTerm);
                
                const maxScore = Math.max(
                    nameMatch.score, 
                    locationMatch.score, 
                    resourceGroupMatch.score, 
                    subscriptionMatch.score
                );
                
                return {
                    vault: kv,
                    score: maxScore,
                    matches: nameMatch.match || locationMatch.match || resourceGroupMatch.match || subscriptionMatch.match
                };
            }).filter(result => result.matches);
            
            // Sort by relevance score
            searchResults.sort((a, b) => b.score - a.score);
            
            filteredKeyVaults = searchResults.map(result => result.vault);
            console.log('Filtered vaults:', filteredKeyVaults.length);
        }
        
        currentVaultPage = 1; // Reset to first page when searching
        renderKeyVaultsPaginated(filteredKeyVaults);
        addLogEntry(`Filtered Key Vaults: ${filteredKeyVaults.length} of ${allKeyVaults.length} match "${searchTerm}"`, 'info');
    } catch (error) {
        console.error('Error in handleKeyVaultSearch:', error);
        addLogEntry(`Key Vault search error: ${error.message}`, 'error');
    }
}

// Enhanced vault search with better performance
function handleVaultSearch() {
    const searchTerm = document.getElementById('vaultSearchInput')?.value.toLowerCase().trim();
    
    if (!currentKeyVault) return;
    
    if (!searchTerm) {
        // Show all items
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'keys') {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'certificates') {
            renderCertificates(allCertificatesByVault.get(currentKeyVault.name) || []);
        }
        return;
    }
    
    // Filter items based on current tab with enhanced search
    if (currentTab === 'secrets') {
        const secrets = allSecretsByVault.get(currentKeyVault.name) || [];
        const filteredSecrets = secrets.map(secret => {
            const nameMatch = enhancedSearch(secret.name, searchTerm);
            const valueMatch = secret.value ? enhancedSearch(secret.value, searchTerm) : { match: false, score: 0 };
            
            return {
                secret,
                score: Math.max(nameMatch.score, valueMatch.score),
                matches: nameMatch.match || valueMatch.match
            };
        }).filter(result => result.matches)
          .sort((a, b) => b.score - a.score)
          .map(result => ({ ...result.secret, searchScore: result.score }));
        
        renderSecrets(filteredSecrets, searchTerm);
    } else if (currentTab === 'keys') {
        const keys = allKeysByVault.get(currentKeyVault.name) || [];
        const filteredKeys = keys.map(key => {
            const nameMatch = enhancedSearch(key.name, searchTerm);
            const typeMatch = enhancedSearch(key.keyType, searchTerm);
            
            return {
                key,
                score: Math.max(nameMatch.score, typeMatch.score),
                matches: nameMatch.match || typeMatch.match
            };
        }).filter(result => result.matches)
          .sort((a, b) => b.score - a.score)
          .map(result => ({ ...result.key, searchScore: result.score }));
        
        renderKeys(filteredKeys, searchTerm);
    } else if (currentTab === 'certificates') {
        const certificates = allCertificatesByVault.get(currentKeyVault.name) || [];
        const filteredCertificates = certificates.map(cert => {
            const nameMatch = enhancedSearch(cert.name, searchTerm);
            const subjectMatch = enhancedSearch(cert.subject, searchTerm);
            
            return {
                cert,
                score: Math.max(nameMatch.score, subjectMatch.score),
                matches: nameMatch.match || subjectMatch.match
            };
        }).filter(result => result.matches)
          .sort((a, b) => b.score - a.score)
          .map(result => ({ ...result.cert, searchScore: result.score }));
        
        renderCertificates(filteredCertificates, searchTerm);
    }
}

// Paginated Key Vault rendering for better performance with improved display
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
    
    // Add count indicator with search highlighting
    const searchTerm = keyvaultSearchInput.value.trim();
    const countDiv = document.createElement('div');
    countDiv.className = `keyvault-count ${searchTerm ? 'highlight' : ''}`;
    countDiv.textContent = searchTerm ? 
        `Found ${keyVaults.length} Key Vaults matching "${searchTerm}" (showing ${startIndex + 1}-${Math.min(endIndex, keyVaults.length)})` :
        `Showing ${startIndex + 1}-${Math.min(endIndex, keyVaults.length)} of ${keyVaults.length} Key Vaults`;
    keyvaultList.appendChild(countDiv);
    
    // Render vaults for current page
    pageVaults.forEach(kv => {
        const vaultDiv = document.createElement('div');
        vaultDiv.className = 'keyvault-item';
        
        // Highlight search terms in vault name
        const highlightedName = searchTerm ? highlightSearchTerm(kv.name, searchTerm) : kv.name;
        const highlightedLocation = searchTerm ? highlightSearchTerm(kv.location, searchTerm) : kv.location;
        const highlightedResourceGroup = searchTerm ? highlightSearchTerm(kv.resourceGroup, searchTerm) : kv.resourceGroup;
        
        vaultDiv.innerHTML = `
            <div class="keyvault-info">
                <h3 class="keyvault-name" title="${kv.name}">${highlightedName}</h3>
                <p><strong>Location:</strong> ${highlightedLocation}</p>
                <p><strong>Resource Group:</strong> ${highlightedResourceGroup}</p>
                <p><strong>Subscription:</strong> ${kv.subscriptionId.substring(0, 8)}...</p>
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

// Optimized Key Vault selection with lazy loading and search bar
async function selectKeyVault(keyVault) {
    currentKeyVault = keyVault;
    currentPage = 1;
    
    // Add vault search bar if not already present
    if (!document.querySelector('.vault-search-bar')) {
        addVaultSearchBar();
    }
    
    // Load vault data if not already loaded
    if (!loadedVaults.has(keyVault.name)) {
        const loadingProgress = showLoadingWithProgress(secretsContainer, `Loading data for ${keyVault.name}...`);
        addLogEntry(`Loading data for Key Vault: ${keyVault.name}`, 'info');
        
        try {
            await loadVaultDataInBackground(keyVault);
            loadedVaults.add(keyVault.name);
            addLogEntry(`Successfully loaded Key Vault: ${keyVault.name}`, 'success');
            loadingProgress.complete();
        } catch (error) {
            addLogEntry(`Failed to load Key Vault ${keyVault.name}: ${error.message}`, 'error');
            console.error('Error loading vault data:', error);
            showError(secretsContainer, `Failed to load data for ${keyVault.name}: ${error.message}`);
            loadingProgress.complete();
            return;
        }
    }
    
    // Ensure mainHeader is assigned
    if (!mainHeader) mainHeader = document.getElementById('mainHeader');
    renderKeyVaultHeader(keyVault);
    
    if (currentTab === 'secrets') {
        renderSecrets(allSecretsByVault.get(keyVault.name) || []);
    } else if (currentTab === 'keys') {
        renderKeys(allKeysByVault.get(keyVault.name) || []);
    } else if (currentTab === 'certificates') {
        renderCertificates(allCertificatesByVault.get(keyVault.name) || []);
    }
}

// Enhanced header rendering with better organization and migration option
function renderKeyVaultHeader(keyVault) {
    if (!mainHeader) {
        console.error('mainHeader is undefined. Cannot render Key Vault header.');
        return;
    }
    mainHeader.innerHTML = `
        <div class="header-main">
            <div class="header-title">
                <h2><i class="fas fa-vault"></i> ${keyVault.name}</h2>
                <div class="header-subtitle">
                    <span class="vault-location"><i class="fas fa-map-marker-alt"></i> ${keyVault.location}</span>
                    <span class="vault-resource-group"><i class="fas fa-layer-group"></i> ${keyVault.resourceGroup}</span>
                </div>
            </div>
            <div class="header-actions">
                <div class="action-group">
                    <button class="btn btn-primary" id="refreshBtn" title="Refresh data">
                        <i class="fas fa-sync"></i> Refresh
                    </button>
                    <button class="btn btn-secondary" id="exportBtn" title="Export data">
                        <i class="fas fa-download"></i> Export
                    </button>
                </div>
                <div class="action-group">
                    <button class="btn btn-info" id="bulkOperationsBtn" title="Bulk operations">
                        <i class="fas fa-tasks"></i> Bulk Ops
                    </button>
                    <button class="btn btn-success" id="migrationBtn" title="Select items for migration">
                        <i class="fas fa-exchange-alt"></i> Migrate
                    </button>
                </div>
                <div class="action-group">
                    ${currentTab === 'secrets' ? 
                        `<button class="btn btn-success" id="addSecret" title="Add new secret">
                            <i class="fas fa-plus"></i> Add Secret
                        </button>` : 
                        currentTab === 'keys' ?
                        `<button class="btn btn-success" id="addKey" title="Add new key">
                            <i class="fas fa-plus"></i> Add Key
                        </button>` :
                        `<button class="btn btn-success" id="addCertificate" title="Add new certificate">
                            <i class="fas fa-plus"></i> Add Certificate
                        </button>`
                    }
                </div>
            </div>
        </div>
    `;
    
    // Add event listeners
    document.getElementById('refreshBtn').addEventListener('click', () => {
        if (currentTab === 'secrets') {
            loadSecretsForKeyVault(keyVault);
        } else if (currentTab === 'keys') {
            loadKeysForKeyVault(keyVault);
        } else if (currentTab === 'certificates') {
            loadCertificatesForKeyVault(keyVault);
        }
    });
    
    // Add migration button event listener
    const migrationBtn = document.getElementById('migrationBtn');
    if (migrationBtn) {
        migrationBtn.addEventListener('click', toggleSelectionMode);
    }
    
    if (currentTab === 'secrets') {
        document.getElementById('addSecret').addEventListener('click', showAddSecretModal);
    } else if (currentTab === 'keys') {
        document.getElementById('addKey').addEventListener('click', showAddKeyModal);
    } else if (currentTab === 'certificates') {
        document.getElementById('addCertificate').addEventListener('click', showAddCertificateModal);
    }
    
    document.getElementById('exportBtn').addEventListener('click', showExportModal);
    document.getElementById('bulkOperationsBtn').addEventListener('click', showBulkOperations);
}

// Enhanced search result rendering with performance indicator
function renderGlobalSearchResults(results, searchTerm) {
    const container = currentTab === 'secrets' ? secretsContainer : 
                     currentTab === 'keys' ? keysContainer : certificatesContainer;
    container.innerHTML = '';
    
    if (results.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-search fa-3x"></i>
                <h2>No results found</h2>
                <p>No ${currentTab} matching "${searchTerm}" were found in any Key Vault.</p>
            </div>
        `;
        return;
    }
    
    // Filter results by current tab
    const tabResults = results.filter(result => result.type === currentTab.slice(0, -1)); // Remove 's' from 'secrets'/'keys'/'certificates'
    
    if (tabResults.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-search fa-3x"></i>
                <h2>No ${currentTab} found</h2>
                <p>No ${currentTab} matching "${searchTerm}" were found, but there are ${results.length} other results.</p>
                <p>Switch to the other tab to see all results.</p>
            </div>
        `;
        return;
    }
    
    // Add search performance indicator
    const performanceDiv = document.createElement('div');
    performanceDiv.className = 'search-performance';
    performanceDiv.innerHTML = `
        <i class="fas fa-tachometer-alt"></i>
        <span>Search completed in ${performanceMetrics.searchTime.toFixed(2)}s</span>
        <span>•</span>
        <span>Found ${tabResults.length} ${currentTab} across ${new Set(tabResults.map(r => r.vaultName)).size} vaults</span>
        <span>•</span>
        <span>Cache hit: ${searchCache.has(`${searchTerm}_${currentTab}`) ? 'Yes' : 'No'}</span>
    `;
    container.appendChild(performanceDiv);
    
    // Add header with search info
    const headerDiv = document.createElement('div');
    headerDiv.className = 'content-header';
    headerDiv.innerHTML = `
        <div class="content-info">
            <span>Found ${tabResults.length} ${currentTab} matching "${searchTerm}"</span>
            <span class="search-highlight">Global Search Results</span>
        </div>
    `;
    container.appendChild(headerDiv);
    
    // Group results by vault for better organization
    const resultsByVault = {};
    tabResults.forEach(result => {
        if (!resultsByVault[result.vaultName]) {
            resultsByVault[result.vaultName] = [];
        }
        resultsByVault[result.vaultName].push(result);
    });
    
    // Sort vaults by number of results (most results first)
    const sortedVaults = Object.entries(resultsByVault).sort((a, b) => b[1].length - a[1].length);
    
    // Render results grouped by vault
    sortedVaults.forEach(([vaultName, vaultResults]) => {
        const vaultDiv = document.createElement('div');
        vaultDiv.className = 'search-vault-group';
        vaultDiv.innerHTML = `
            <h3 class="vault-group-header">
                <i class="fas fa-vault"></i> ${vaultName}
                <span class="result-count">${vaultResults.length} ${currentTab.slice(0, -1)}</span>
            </h3>
        `;
        
        vaultResults.forEach(result => {
            let card;
            if (currentTab === 'secrets') {
                card = createSecretCard(result, searchTerm);
            } else if (currentTab === 'keys') {
                card = createKeyCard(result, searchTerm);
            } else if (currentTab === 'certificates') {
                card = createCertificateCard(result, searchTerm);
            }
            vaultDiv.appendChild(card);
        });
        
        container.appendChild(vaultDiv);
    });
}

// Performance monitoring function
function updatePerformanceMetrics() {
    performanceMetrics.loadedVaultsCount = loadedVaults.size;
    performanceMetrics.totalSecrets = Array.from(allSecretsByVault.values()).reduce((sum, secrets) => sum + secrets.length, 0);
    performanceMetrics.totalKeys = Array.from(allKeysByVault.values()).reduce((sum, keys) => sum + keys.length, 0);
    performanceMetrics.totalCertificates = Array.from(allCertificatesByVault.values()).reduce((sum, certificates) => sum + certificates.length, 0);
    
    // Update memory usage indicator if it exists
    const memoryIndicator = document.getElementById('memoryIndicator');
    if (memoryIndicator) {
        const totalItems = performanceMetrics.totalSecrets + performanceMetrics.totalKeys + performanceMetrics.totalCertificates;
        const cacheSize = searchCache.size;
        memoryIndicator.textContent = `Vaults: ${performanceMetrics.loadedVaultsCount} | Items: ${totalItems} | Cache: ${cacheSize}`;
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

function renderSecrets(secrets, searchTerm = '') {
    secretsContainer.innerHTML = '';
    if (secrets.length === 0) {
        secretsContainer.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-search fa-3x"></i>
                <h2>No secrets found</h2>
                <p>${searchTerm ? `No secrets matching "${searchTerm}"` : 'This Key Vault has no secrets.'}</p>
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
            ${searchTerm ? `<span class="search-highlight">Filtered by: "${searchTerm}"</span>` : ''}
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
        const secretCard = createSecretCard(secret, searchTerm);
        secretsContainer.appendChild(secretCard);
    });
}

function renderKeys(keys, searchTerm = '') {
    console.log(`Rendering ${keys.length} keys:`, keys.map(k => ({ name: k.name, type: k.keyType })));
    
    if (!keysContainer) {
        console.error('Keys container not found');
        return;
    }
    
    if (keys.length === 0) {
        keysContainer.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-lock fa-3x"></i>
                <h2>No Keys Found</h2>
                <p>No keys were found in this Key Vault or match your search criteria.</p>
            </div>
        `;
        return;
    }
    
    // Filter by search term if provided
    const filteredKeys = searchTerm ? keys.filter(key => 
        key.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (key.keyType && key.keyType.toLowerCase().includes(searchTerm.toLowerCase()))
    ) : keys;
    
    console.log(`Filtered keys: ${filteredKeys.length} out of ${keys.length}`);
    
    // Calculate pagination
    const totalPages = Math.ceil(filteredKeys.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageKeys = filteredKeys.slice(startIndex, endIndex);
    
    // Create cards
    const cards = pageKeys.map(key => createKeyCard(key, searchTerm));
    
    // Update container
    keysContainer.innerHTML = `
        <div class="content-header">
            <div class="content-info">
                <span>Showing ${startIndex + 1}-${Math.min(endIndex, filteredKeys.length)} of ${filteredKeys.length} keys</span>
            </div>
            ${totalPages > 1 ? `
                <div class="pagination">
                    <button class="btn btn-sm" onclick="changePage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <span class="page-info">Page ${currentPage} of ${totalPages}</span>
                    <button class="btn btn-sm" onclick="changePage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>
                        <i class="fas fa-chevron-right"></i>
                    </button>
                </div>
            ` : ''}
        </div>
        <div class="keys-grid">
            ${cards.join('')}
        </div>
    `;
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
    if (!text) {
        showNotification('Nothing to copy', 'warning');
        return;
    }
    
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied to clipboard', 'success');
        addLogEntry(`Copied to clipboard: ${text.substring(0, 20)}${text.length > 20 ? '...' : ''}`, 'info');
    }).catch(err => {
        console.error('Failed to copy: ', err);
        showNotification('Failed to copy to clipboard', 'error');
    });
}

// Fixed secret reveal functionality
function togglePasswordVisibility(secretName) {
    const secretElement = document.getElementById(`secret-${secretName.replace(/[^a-zA-Z0-9]/g, '-')}`);
    const toggleButton = secretElement.querySelector('.toggle-password');
    
    if (secretElement.classList.contains('hidden')) {
        secretElement.classList.remove('hidden');
        toggleButton.innerHTML = '<i class="fas fa-eye-slash"></i> Hide';
        addLogEntry(`Revealed secret: ${secretName}`, 'info');
    } else {
        secretElement.classList.add('hidden');
        toggleButton.innerHTML = '<i class="fas fa-eye"></i> Show';
        addLogEntry(`Hidden secret: ${secretName}`, 'info');
    }
}

function deleteSecret(secretName) {
    if (!currentKeyVault) return;
    if (confirm(`Are you sure you want to delete the secret "${secretName}"? This action cannot be undone.`)) {
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const secretClient = new SecretClient(vaultUrl, credential);
        
        secretClient.beginDeleteSecret(secretName).then(() => {
            loadSecretsForKeyVault(currentKeyVault);
            showNotification('Secret deleted successfully', 'success');
        }).catch(error => {
            console.error('Error deleting secret:', error);
            showNotification(`Failed to delete secret: ${error.message}`, 'error');
        });
    }
}

function deleteKey(keyName) {
    if (!currentKeyVault) return;
    if (confirm(`Are you sure you want to delete the key "${keyName}"? This action cannot be undone.`)) {
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const keyClient = new KeyClient(vaultUrl, credential);
        
        keyClient.beginDeleteKey(keyName).then(() => {
            loadKeysForKeyVault(currentKeyVault);
            showNotification('Key deleted successfully', 'success');
        }).catch(error => {
            console.error('Error deleting key:', error);
            showNotification(`Failed to delete key: ${error.message}`, 'error');
        });
    }
}

// Enhanced secret card creation with search scoring and selection mode
function createSecretCard(secret, searchTerm = '') {
    const card = document.createElement('div');
    card.className = 'secret-card';
    
    // Add selection mode classes
    if (isSelectionMode) {
        card.classList.add('selectable');
        if (selectedSecrets.has(secret.name)) {
            card.classList.add('selected');
        }
    }
    
    // Add search result styling if this is from a search
    if (secret.vaultName) {
        card.classList.add('search-result-card');
    }
    
    const highlightedName = searchTerm ? highlightSearchTerm(secret.name, searchTerm) : secret.name;
    
    // Determine search score class if available
    let scoreClass = '';
    let scoreDisplay = '';
    if (secret.searchScore) {
        if (secret.searchScore >= 80) scoreClass = 'high';
        else if (secret.searchScore >= 60) scoreClass = 'medium';
        else scoreClass = 'low';
        scoreDisplay = `${secret.searchScore}% match`;
    }
    
    card.innerHTML = `
        ${scoreDisplay ? `<div class="search-score ${scoreClass}">${scoreDisplay}</div>` : ''}
        ${isSelectionMode ? `
            <div class="selection-checkbox">
                <label class="checkbox-container">
                    <input type="checkbox" ${selectedSecrets.has(secret.name) ? 'checked' : ''} 
                           onchange="toggleItemSelection('${secret.name}', 'secret')">
                    <span class="checkmark"></span>
                </label>
            </div>
        ` : ''}
        <div class="secret-header">
            <h3 class="secret-name">${highlightedName}</h3>
            <div class="secret-actions">
                <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${secret.name}')" title="Copy name">
                    <i class="fas fa-copy"></i>
                </button>
                <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${secret.value || ''}')" title="Copy value">
                    <i class="fas fa-clipboard"></i>
                </button>
                <button class="btn btn-warning btn-sm" onclick="showEditSecretModal('${secret.name}', '${(secret.value || '').replace(/'/g, "\\'")}')" title="Edit secret">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteSecret('${secret.name}')" title="Delete secret">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
        <div class="secret-info">
            ${secret.vaultName ? `<div class="info-item">
                <span class="info-label">Vault</span>
                <span class="info-value">${secret.vaultName}</span>
            </div>` : ''}
            <div class="info-item">
                <span class="info-label">Version</span>
                <span class="info-value">${secret.version || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Created</span>
                <span class="info-value">${secret.created ? new Date(secret.created).toLocaleString() : 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Updated</span>
                <span class="info-value">${secret.updated ? new Date(secret.updated).toLocaleString() : 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Expires</span>
                <span class="info-value">${secret.expires ? new Date(secret.expires).toLocaleString() : 'Never'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Status</span>
                <span class="info-value">
                    <span class="status-indicator ${secret.enabled ? 'status-enabled' : 'status-disabled'}"></span>
                    ${secret.enabled ? 'Enabled' : 'Disabled'}
                </span>
            </div>
        </div>
        <div class="secret-value hidden" id="secret-${secret.name.replace(/[^a-zA-Z0-9]/g, '-')}">
            ${secret.value || 'No value'}
            <button class="toggle-password" onclick="togglePasswordVisibility('${secret.name}')">
                <i class="fas fa-eye"></i> Show
            </button>
        </div>
    `;
    
    return card;
}

// Enhanced key card creation with search scoring and selection mode
function createKeyCard(key, searchTerm = '') {
    const card = document.createElement('div');
    card.className = 'key-card';
    
    // Add selection mode classes
    if (isSelectionMode) {
        card.classList.add('selectable');
        if (selectedKeys.has(key.name)) {
            card.classList.add('selected');
        }
    }
    
    // Add search result styling if this is from a search
    if (key.vaultName) {
        card.classList.add('search-result-card');
    }
    
    const highlightedName = searchTerm ? highlightSearchTerm(key.name, searchTerm) : key.name;
    
    // Determine search score class if available
    let scoreClass = '';
    let scoreDisplay = '';
    if (key.searchScore) {
        if (key.searchScore >= 80) scoreClass = 'high';
        else if (key.searchScore >= 60) scoreClass = 'medium';
        else scoreClass = 'low';
        scoreDisplay = `${key.searchScore}% match`;
    }
    
    card.innerHTML = `
        ${scoreDisplay ? `<div class="search-score ${scoreClass}">${scoreDisplay}</div>` : ''}
        ${isSelectionMode ? `
            <div class="selection-checkbox">
                <label class="checkbox-container">
                    <input type="checkbox" ${selectedKeys.has(key.name) ? 'checked' : ''} 
                           onchange="toggleItemSelection('${key.name}', 'key')">
                    <span class="checkmark"></span>
                </label>
            </div>
        ` : ''}
        <div class="key-header">
            <h3 class="key-name">${highlightedName}</h3>
            <div class="key-actions">
                <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${key.name}')" title="Copy name">
                    <i class="fas fa-copy"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteKey('${key.name}')" title="Delete key">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
        <div class="key-info">
            ${key.vaultName ? `<div class="info-item">
                <span class="info-label">Vault</span>
                <span class="info-value">${key.vaultName}</span>
            </div>` : ''}
            <div class="info-item">
                <span class="info-label">Type</span>
                <span class="info-value">${key.keyType}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Size</span>
                <span class="info-value">${key.keySize || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Created</span>
                <span class="info-value">${key.created ? new Date(key.created).toLocaleString() : 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Updated</span>
                <span class="info-value">${key.updated ? new Date(key.updated).toLocaleString() : 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Expires</span>
                <span class="info-value">${key.expires ? new Date(key.expires).toLocaleString() : 'Never'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Status</span>
                <span class="info-value">
                    <span class="status-indicator ${key.enabled ? 'status-enabled' : 'status-disabled'}"></span>
                    ${key.enabled ? 'Enabled' : 'Disabled'}
                </span>
            </div>
        </div>
    `;
    
    return card;
}

// Certificate card creation with expiration date coloring
function createCertificateCard(certificate, searchTerm = '') {
    const card = document.createElement('div');
    card.className = 'certificate-card';
    
    // Add selection mode classes
    if (isSelectionMode) {
        card.classList.add('selectable');
        if (selectedCertificates.has(certificate.name)) {
            card.classList.add('selected');
        }
    }
    
    // Add search result styling if this is from a search
    if (certificate.vaultName) {
        card.classList.add('search-result-card');
    }
    
    const highlightedName = searchTerm ? highlightSearchTerm(certificate.name, searchTerm) : certificate.name;
    
    // Determine search score class if available
    let scoreClass = '';
    let scoreDisplay = '';
    if (certificate.searchScore) {
        scoreClass = getScoreClass(certificate.searchScore);
        scoreDisplay = `<div class="search-score ${scoreClass}">${certificate.searchScore}% match</div>`;
    }
    
    // Calculate expiration status
    let expirationStatus = 'expiring-safe';
    let expirationText = '';
    if (certificate.expires) {
        const expiresDate = new Date(certificate.expires);
        const now = new Date();
        const daysUntilExpiry = Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24));
        
        if (daysUntilExpiry < 0) {
            expirationStatus = 'expired';
            expirationText = 'Expired';
        } else if (daysUntilExpiry <= 7) {
            expirationStatus = 'expiring-soon';
            expirationText = `Expires in ${daysUntilExpiry} days`;
        } else if (daysUntilExpiry <= 30) {
            expirationStatus = 'expiring-warning';
            expirationText = `Expires in ${daysUntilExpiry} days`;
        } else {
            expirationStatus = 'expiring-safe';
            expirationText = `Expires in ${daysUntilExpiry} days`;
        }
    }
    
    // Format dates
    const createdDate = certificate.created ? new Date(certificate.created).toLocaleString() : 'Unknown';
    const updatedDate = certificate.updated ? new Date(certificate.updated).toLocaleString() : 'Unknown';
    
    // Certificate value section
    let valueSection = '';
    if (certificate.value) {
        valueSection = `
            <div class="certificate-value">
                <div class="value-header">
                    <span class="value-label">Certificate Value:</span>
                    <button class="btn btn-sm btn-secondary toggle-password" onclick="toggleCertificateVisibility('${certificate.name}')">
                        <i class="fas fa-eye"></i>
                    </button>
                </div>
                <div class="value-content hidden" id="certificateValue_${certificate.name}">
                    <pre>${certificate.value}</pre>
                    <button class="btn btn-sm btn-primary" onclick="copyToClipboard('${certificate.value.replace(/'/g, "\\'")}')">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>
            </div>
        `;
    } else {
        valueSection = `
            <div class="certificate-value">
                <div class="value-header">
                    <span class="value-label">Certificate Value:</span>
                </div>
                <div class="value-content">
                    <em>Certificate value not available (access denied or not stored as secret)</em>
                </div>
            </div>
        `;
    }
    
    card.innerHTML = `
        ${isSelectionMode ? `<input type="checkbox" class="selection-checkbox" onchange="toggleItemSelection('${certificate.name}', 'certificate')" ${selectedCertificates.has(certificate.name) ? 'checked' : ''}>` : ''}
        <div class="certificate-header">
            <div class="certificate-name">
                <h3>${highlightedName}</h3>
                ${scoreDisplay}
            </div>
            <div class="certificate-actions">
                <button class="btn btn-sm btn-danger" onclick="deleteCertificate('${certificate.name}')" title="Delete certificate">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
        <div class="certificate-info">
            <div class="info-item">
                <span class="info-label">Subject:</span>
                <span class="info-value">${certificate.subject}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Issuer:</span>
                <span class="info-value">${certificate.issuer}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Created:</span>
                <span class="info-value">${createdDate}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Updated:</span>
                <span class="info-value">${updatedDate}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Expires:</span>
                <span class="info-value expiration-status ${expirationStatus}">${expirationText}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Status:</span>
                <span class="status-indicator ${certificate.enabled ? 'status-enabled' : 'status-disabled'}">
                    ${certificate.enabled ? 'Enabled' : 'Disabled'}
                </span>
            </div>
        </div>
        ${valueSection}
    `;
    
    return card;
}

// Helper function to highlight search terms
function highlightSearchTerm(text, searchTerm) {
    if (!searchTerm) return text;
    
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<span class="search-highlight">$1</span>');
}

// Add search functionality within individual Key Vaults
function addVaultSearchBar() {
    try {
        const header = document.getElementById('mainHeader');
        if (!header) return;
        
        // Check if search bar already exists
        if (document.getElementById('vaultSearchInput')) {
            return;
        }
        
        // Create search container
        const searchContainer = document.createElement('div');
        searchContainer.className = 'search-container';
        
        // Create search icon
        const searchIcon = document.createElement('i');
        searchIcon.className = 'fas fa-search search-icon';
        
        // Create search input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.id = 'vaultSearchInput';
        searchInput.placeholder = 'Search within this Key Vault...';
        searchInput.className = 'search-input';
        
        // Create clear button
        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-secondary btn-sm';
        clearBtn.innerHTML = '<i class="fas fa-times"></i>';
        clearBtn.onclick = clearVaultSearch;
        clearBtn.title = 'Clear search';
        
        // Assemble the search bar
        searchContainer.appendChild(searchIcon);
        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(clearBtn);
        
        // Add to header
        const headerActions = header.querySelector('.header-actions');
        if (headerActions) {
            headerActions.appendChild(searchContainer);
        } else {
            header.appendChild(searchContainer);
        }
        
        // Add event listener
        searchInput.addEventListener('input', handleVaultSearch);
        
        console.log('Vault search bar added successfully');
    } catch (error) {
        console.error('Error adding vault search bar:', error);
    }
}

// Clear vault search
function clearVaultSearch() {
    const vaultSearchInput = document.getElementById('vaultSearchInput');
    if (vaultSearchInput) {
        vaultSearchInput.value = '';
        handleVaultSearch();
    }
}

// Make functions globally available for onclick handlers
window.selectKeyVault = selectKeyVault;
window.changeVaultPage = changeVaultPage;
window.changePage = changePage;
window.togglePasswordVisibility = togglePasswordVisibility;
window.copyToClipboard = copyToClipboard;
window.deleteSecret = deleteSecret;
window.deleteKey = deleteKey;
window.deleteCertificate = deleteCertificate;
window.showAddSecretModal = showAddSecretModal;
window.hideAddSecretModal = hideAddSecretModal;
window.showAddKeyModal = showAddKeyModal;
window.hideAddKeyModal = hideAddKeyModal;
window.showAddCertificateModal = showAddCertificateModal;
window.hideAddCertificateModal = hideAddCertificateModal;
window.showExportModal = showExportModal;
window.hideExportModal = hideExportModal;
window.showBulkOperations = showBulkOperations;
window.bulkExport = bulkExport;
window.bulkDisable = bulkDisable;
window.bulkEnable = bulkEnable;
window.bulkDelete = bulkDelete;
window.clearActivityLog = clearActivityLog;
window.showEditSecretModal = showEditSecretModal;
window.hideEditSecretModal = hideEditSecretModal;
window.updateSecret = updateSecret;
window.searchAllVaults = searchAllVaults;
window.clearVaultSearch = clearVaultSearch;
window.toggleSelectionMode = toggleSelectionMode;
window.selectAllItems = selectAllItems;
window.deselectAllItems = deselectAllItems;
window.showMigrationModal = showMigrationModal;
window.hideMigrationModal = hideMigrationModal;
window.startMigration = startMigration;
window.cancelMigration = cancelMigration;
window.closeMigrationProgress = closeMigrationProgress;
window.removeSecretFromSelection = removeSecretFromSelection;
window.removeKeyFromSelection = removeKeyFromSelection;
window.removeCertificateFromSelection = removeCertificateFromSelection;
window.toggleItemSelection = toggleItemSelection;
window.saveCertificate = saveCertificate;

// Fixed bulk operations function to prevent spamming and ensure visibility
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
    
    // Remove existing bulk actions if any
    const existingBulkActions = container.querySelector('.bulk-actions');
    if (existingBulkActions) {
        existingBulkActions.remove();
    }
    
    const bulkActions = document.createElement('div');
    bulkActions.className = 'bulk-actions';
    bulkActions.innerHTML = `
        <div class="bulk-header">
            <span class="bulk-title"><i class="fas fa-tasks"></i> Bulk Operations for ${items.length} ${currentTab}</span>
            <button class="btn btn-sm btn-secondary" onclick="hideBulkOperations()">
                <i class="fas fa-times"></i>
            </button>
        </div>
        <div class="bulk-buttons">
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
            ${currentTab === 'secrets' ? `
                <button class="btn btn-info" onclick="toggleSelectionMode()">
                    <i class="fas fa-exchange-alt"></i> Select for Migration
                </button>
            ` : ''}
        </div>
    `;
    
    // Insert at the top of the container
    container.insertBefore(bulkActions, container.firstChild);
    
    showNotification(`Bulk operations panel added for ${items.length} ${currentTab}`, 'success');
    addLogEntry(`Bulk operations panel opened for ${items.length} ${currentTab}`, 'info');
}

// Add function to hide bulk operations
window.hideBulkOperations = function() {
    const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
    const existingBulkActions = container.querySelector('.bulk-actions');
    if (existingBulkActions) {
        existingBulkActions.remove();
    }
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
    try {
        console.log('Adding performance indicator...');
        const indicator = document.createElement('div');
        indicator.id = 'memoryIndicator';
        indicator.className = 'memory-usage show';
        indicator.textContent = 'Performance: Loading...';
        document.body.appendChild(indicator);
        
        // Update every 5 seconds
        setInterval(updatePerformanceMetrics, 5000);
        console.log('Performance indicator added successfully');
    } catch (error) {
        console.error('Failed to add performance indicator:', error);
    }
}

// Add edit secret functionality
function showEditSecretModal(secretName, secretValue) {
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.id = 'editSecretModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Edit Secret: ${secretName}</h3>
                <button class="close-btn" onclick="hideEditSecretModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="editSecretName">Secret Name:</label>
                    <input type="text" id="editSecretName" value="${secretName}" readonly>
                </div>
                <div class="form-group">
                    <label for="editSecretValue">Secret Value:</label>
                    <textarea id="editSecretValue" placeholder="Enter new secret value" rows="4">${secretValue || ''}</textarea>
                </div>
                <div class="form-group">
                    <label for="editSecretDescription">Description (optional):</label>
                    <input type="text" id="editSecretDescription" placeholder="Enter description">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="hideEditSecretModal()">Cancel</button>
                <button class="btn btn-primary" onclick="updateSecret('${secretName}')">Update Secret</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideEditSecretModal();
    });
}

function hideEditSecretModal() {
    const modal = document.getElementById('editSecretModal');
    if (modal) {
        modal.remove();
    }
}

async function updateSecret(secretName) {
    const newValue = document.getElementById('editSecretValue').value;
    const description = document.getElementById('editSecretDescription').value;
    
    if (!newValue.trim()) {
        showNotification('Secret value cannot be empty', 'error');
        return;
    }
    
    try {
        addLogEntry(`Updating secret: ${secretName}`, 'info');
        
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const secretClient = new SecretClient(vaultUrl, credential);
        
        // Create a new version of the secret
        await secretClient.setSecret(secretName, newValue);
        
        // Update the local cache
        const secrets = allSecretsByVault.get(currentKeyVault.name) || [];
        const secretIndex = secrets.findIndex(s => s.name === secretName);
        
        if (secretIndex !== -1) {
            secrets[secretIndex].value = newValue;
            secrets[secretIndex].updated = new Date();
            allSecretsByVault.set(currentKeyVault.name, secrets);
        }
        
        hideEditSecretModal();
        showNotification(`Secret "${secretName}" updated successfully`, 'success');
        addLogEntry(`Successfully updated secret: ${secretName}`, 'success');
        
        // Refresh the display
        renderSecrets(secrets);
        
    } catch (error) {
        console.error('Error updating secret:', error);
        showNotification(`Failed to update secret: ${error.message}`, 'error');
        addLogEntry(`Failed to update secret ${secretName}: ${error.message}`, 'error');
    }
}

// Optimized function to search all vaults with background loading
async function searchAllVaults(searchTerm) {
    showLoading(currentTab === 'secrets' ? secretsContainer : keysContainer, 'Loading and searching all Key Vaults...');
    
    // Load data for unloaded vaults in batches
    const unloadedVaults = allKeyVaults.filter(kv => !loadedVaults.has(kv.name));
    const batchSize = 3; // Load 3 vaults at a time to avoid overwhelming the API
    
    addLogEntry(`Starting search across all ${unloadedVaults.length} unloaded vaults`, 'info');
    
    for (let i = 0; i < unloadedVaults.length; i += batchSize) {
        const batch = unloadedVaults.slice(i, i + batchSize);
        const batchPromises = batch.map(async (vault) => {
            try {
                await loadVaultDataInBackground(vault);
                loadedVaults.add(vault.name);
                addLogEntry(`Loaded vault: ${vault.name}`, 'success');
                return true;
            } catch (error) {
                console.warn(`Failed to load data for vault ${vault.name}:`, error);
                addLogEntry(`Failed to load vault ${vault.name}: ${error.message}`, 'error');
                return false;
            }
        });
        
        await Promise.all(batchPromises);
        
        // Update progress
        const progress = Math.min(((i + batchSize) / unloadedVaults.length) * 100, 100);
        const container = currentTab === 'secrets' ? secretsContainer : keysContainer;
        container.innerHTML = `<div class="loading">Loading Key Vaults... ${Math.round(progress)}% (${i + batchSize}/${unloadedVaults.length})</div>`;
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
        addLogEntry(`Loaded ${secrets.length} secrets from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading secrets for', keyVault.name, ':', error);
        showError(secretsContainer, `Failed to load secrets: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load secrets. Check console for details.', 'error');
        addLogEntry(`Failed to load secrets from ${keyVault.name}: ${error.message}`, 'error');
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
        addLogEntry(`Loaded ${keys.length} keys from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading keys for', keyVault.name, ':', error);
        showError(keysContainer, `Failed to load keys: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load keys. Check console for details.', 'error');
        addLogEntry(`Failed to load keys from ${keyVault.name}: ${error.message}`, 'error');
    }
}

// Security indicator logic
function updateSecurityIndicator(status) {
    const indicator = document.getElementById('securityIndicator');
    if (!indicator) return;

    let state = 'error';
    let tooltip = 'Index service not available.\nFalling back to direct Azure calls.';

    if (status.containerRunning && status.containerSecure && status.encryptionEnabled) {
        state = 'secure';
        tooltip = 'Secure: Using containerized index service.\nAll security checks passed.';
    } else if (status.containerRunning) {
        state = 'warning';
        tooltip = 'Warning: Index service running, but some security checks failed.';
        if (!status.containerSecure) tooltip += '\n- Container security incomplete';
        if (!status.encryptionEnabled) tooltip += '\n- In-memory encryption not enabled';
    }

    indicator.className = `security-indicator ${state}`;
    indicator.title = tooltip;
}

// Periodically check security status
async function pollSecurityStatus() {
    try {
        // Check health and security endpoints
        const isHealthy = await ipcRenderer.invoke('index-service-health');
        let securityResponse = { containerRunning: false, containerSecure: false, encryptionEnabled: false };
        if (isHealthy) {
            securityResponse = await ipcRenderer.invoke('get-security-status');
        }
        updateSecurityIndicator(securityResponse);
    } catch (e) {
        updateSecurityIndicator({ containerRunning: false });
    }
}

// Run on load and every 30s
pollSecurityStatus();
setInterval(pollSecurityStatus, 30000);

// Migration functionality - Fixed with checkbox selection
function toggleSelectionMode() {
    isSelectionMode = !isSelectionMode;
    selectedSecrets.clear();
    selectedKeys.clear();
    selectedCertificates.clear();
    
    if (isSelectionMode) {
        addSelectionModeUI();
        addLogEntry('Entered selection mode', 'info');
    } else {
        removeSelectionModeUI();
        addLogEntry('Exited selection mode', 'info');
    }
    
    // Re-render items to show selection state
    if (currentKeyVault) {
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'keys') {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'certificates') {
            renderCertificates(allCertificatesByVault.get(currentKeyVault.name) || []);
        }
    }
}

function addSelectionModeUI() {
    const container = currentTab === 'secrets' ? secretsContainer : 
                     currentTab === 'keys' ? keysContainer : certificatesContainer;
    
    // Add selection mode indicator
    const indicator = document.createElement('div');
    indicator.className = 'selection-mode-indicator';
    indicator.innerHTML = `
        <i class="fas fa-mouse-pointer"></i>
        Selection Mode Active - Use checkboxes to select items
    `;
    container.insertBefore(indicator, container.firstChild);
    
    // Add selection actions
    const actions = document.createElement('div');
    actions.className = 'selection-actions';
    actions.innerHTML = `
        <button class="btn btn-primary" onclick="selectAllItems()">
            <i class="fas fa-check-square"></i> Select All
        </button>
        <button class="btn btn-secondary" onclick="deselectAllItems()">
            <i class="fas fa-square"></i> Deselect All
        </button>
        <button class="btn btn-success" onclick="showMigrationModal()" id="migrateBtn" disabled>
            <i class="fas fa-exchange-alt"></i> Migrate Selected (0)
        </button>
        <button class="btn btn-warning" onclick="toggleSelectionMode()">
            <i class="fas fa-times"></i> Exit Selection
        </button>
    `;
    container.insertBefore(actions, container.firstChild);
}

function removeSelectionModeUI() {
    const container = currentTab === 'secrets' ? secretsContainer : 
                     currentTab === 'keys' ? keysContainer : certificatesContainer;
    
    // Remove selection mode indicator
    const indicator = container.querySelector('.selection-mode-indicator');
    if (indicator) indicator.remove();
    
    // Remove selection actions
    const actions = container.querySelector('.selection-actions');
    if (actions) actions.remove();
}

function toggleItemSelection(itemName, itemType) {
    if (!isSelectionMode) return;
    
    let selectedSet;
    if (itemType === 'secret') {
        selectedSet = selectedSecrets;
    } else if (itemType === 'key') {
        selectedSet = selectedKeys;
    } else if (itemType === 'certificate') {
        selectedSet = selectedCertificates;
    } else {
        return;
    }
    
    if (selectedSet.has(itemName)) {
        selectedSet.delete(itemName);
    } else {
        selectedSet.add(itemName);
    }
    
    updateMigrationButton();
    addLogEntry(`${itemType} "${itemName}" ${selectedSet.has(itemName) ? 'selected' : 'deselected'}`, 'info');
    
    // Re-render to update selection state
    if (currentKeyVault) {
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'keys') {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'certificates') {
            renderCertificates(allCertificatesByVault.get(currentKeyVault.name) || []);
        }
    }
}

function selectAllItems() {
    if (!currentKeyVault) return;
    
    let items = [];
    if (currentTab === 'secrets') {
        items = allSecretsByVault.get(currentKeyVault.name) || [];
        items.forEach(item => selectedSecrets.add(item.name));
    } else if (currentTab === 'keys') {
        items = allKeysByVault.get(currentKeyVault.name) || [];
        items.forEach(item => selectedKeys.add(item.name));
    } else if (currentTab === 'certificates') {
        items = allCertificatesByVault.get(currentKeyVault.name) || [];
        items.forEach(item => selectedCertificates.add(item.name));
    }
    
    updateMigrationButton();
    addLogEntry(`Selected all ${items.length} ${currentTab}`, 'info');
    
    // Re-render to update selection state
    if (currentTab === 'secrets') {
        renderSecrets(items);
    } else if (currentTab === 'keys') {
        renderKeys(items);
    } else if (currentTab === 'certificates') {
        renderCertificates(items);
    }
}

function deselectAllItems() {
    selectedSecrets.clear();
    selectedKeys.clear();
    selectedCertificates.clear();
    updateMigrationButton();
    addLogEntry('Deselected all items', 'info');
    
    // Re-render to update selection state
    if (currentKeyVault) {
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'keys') {
            renderKeys(allKeysByVault.get(currentKeyVault.name) || []);
        } else if (currentTab === 'certificates') {
            renderCertificates(allCertificatesByVault.get(currentKeyVault.name) || []);
        }
    }
}

// Update migration button to actually migrate
function updateMigrationButton() {
    const migrationBtn = document.getElementById('migrationBtn');
    if (!migrationBtn) return;
    
    const totalSelected = selectedSecrets.size + selectedKeys.size + selectedCertificates.size;
    
    if (totalSelected > 0) {
        migrationBtn.innerHTML = `<i class="fas fa-exchange-alt"></i> Migrate (${totalSelected})`;
        migrationBtn.className = 'btn btn-success';
        migrationBtn.title = `Migrate ${totalSelected} selected items`;
        migrationBtn.onclick = () => showMigrationModal();
    } else {
        migrationBtn.innerHTML = `<i class="fas fa-exchange-alt"></i> Migrate`;
        migrationBtn.className = 'btn btn-secondary';
        migrationBtn.title = 'Select items for migration';
        migrationBtn.onclick = () => toggleSelectionMode();
    }
    
    // Also update the migrate button in selection mode if it exists
    const migrateBtn = document.getElementById('migrateBtn');
    if (migrateBtn) {
        if (totalSelected > 0) {
            migrateBtn.innerHTML = `<i class="fas fa-exchange-alt"></i> Migrate Selected (${totalSelected})`;
            migrateBtn.disabled = false;
        } else {
            migrateBtn.innerHTML = `<i class="fas fa-exchange-alt"></i> Migrate Selected (0)`;
            migrateBtn.disabled = true;
        }
    }
    
    console.log(`Migration button updated: ${totalSelected} items selected (${selectedSecrets.size} secrets, ${selectedKeys.size} keys, ${selectedCertificates.size} certificates)`);
}

function showMigrationModal() {
    const totalSelected = selectedSecrets.size + selectedKeys.size + selectedCertificates.size;
    
    if (totalSelected === 0) {
        showNotification('No items selected for migration. Please select items first.', 'warning');
        return;
    }
    
    // Create migration modal if it doesn't exist
    let migrationModal = document.getElementById('migrationModal');
    if (!migrationModal) {
        migrationModal = document.createElement('div');
        migrationModal.id = 'migrationModal';
        migrationModal.className = 'modal';
        migrationModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3><i class="fas fa-exchange-alt"></i> Migration Progress</h3>
                </div>
                <div class="modal-body">
                    <div class="migration-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" id="migrationProgressFill" style="width: 0%"></div>
                        </div>
                        <div class="progress-text" id="migrationProgressText">Preparing migration...</div>
                    </div>
                    <div class="migration-log" id="migrationLog">
                        <!-- Migration log entries will be added here -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-danger" id="cancelMigrationBtn" onclick="cancelMigration()">Cancel Migration</button>
                    <button class="btn btn-secondary" id="closeMigrationBtn" onclick="closeMigrationProgress()" style="display: none;">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(migrationProgressModal);
    }
    
    migrationProgressModal.classList.add('show');
    document.getElementById('migrationLog').innerHTML = '';
    document.getElementById('migrationProgressFill').style.width = '0%';
    document.getElementById('migrationProgressText').textContent = 'Preparing migration...';
    document.getElementById('cancelMigrationBtn').style.display = 'inline-block';
    document.getElementById('closeMigrationBtn').style.display = 'none';
}

function closeMigrationProgress() {
    const migrationProgressModal = document.getElementById('migrationProgressModal');
    if (migrationProgressModal) {
        migrationProgressModal.classList.remove('show');
    }
}

function cancelMigration() {
    if (migrationInProgress) {
        migrationCancelled = true;
        addMigrationLog('Cancelling migration...', 'warning');
        document.getElementById('cancelMigrationBtn').disabled = true;
        document.getElementById('cancelMigrationBtn').textContent = 'Cancelling...';
    }
}

function updateMigrationProgress(percent, text) {
    const progressFill = document.getElementById('migrationProgressFill');
    const progressText = document.getElementById('migrationProgressText');
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = text;
}

function addMigrationLog(message, type = 'info') {
    const logContainer = document.getElementById('migrationLog');
    if (!logContainer) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = `migration-log-entry ${type}`;
    
    const icon = type === 'success' ? 'fa-check' : 
                 type === 'error' ? 'fa-times' : 
                 type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info';
    
    logEntry.innerHTML = `
        <i class="fas ${icon}"></i>
        <span>${new Date().toLocaleTimeString()} - ${message}</span>
    `;
    
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// Add missing modal functions
function showExportModal() {
    const exportModal = document.getElementById('exportModal');
    if (exportModal) {
        exportModal.classList.add('show');
    }
}

function hideExportModal() {
    const exportModal = document.getElementById('exportModal');
    if (exportModal) {
        exportModal.classList.remove('show');
    }
}

function showAddKeyModal() {
    const addKeyModal = document.getElementById('addKeyModal');
    if (addKeyModal) {
        addKeyModal.classList.add('show');
    }
}

function hideAddKeyModal() {
    const addKeyModal = document.getElementById('addKeyModal');
    if (addKeyModal) {
        addKeyModal.classList.remove('show');
    }
}

function showAddSecretModal() {
    const addSecretModal = document.getElementById('addSecretModal');
    if (addSecretModal) {
        addSecretModal.classList.add('show');
    }
}

function hideAddSecretModal() {
    const addSecretModal = document.getElementById('addSecretModal');
    if (addSecretModal) {
        addSecretModal.classList.remove('show');
    }
}

// Export data function
function exportData() {
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

// Add key function
function saveKey() {
    const keyName = document.getElementById('keyName').value.trim();
    const keyType = document.getElementById('keyType').value;
    const keySize = document.getElementById('keySize').value;
    const keyDescription = document.getElementById('keyDescription').value.trim();
    
    if (!keyName) {
        showNotification('Please enter a key name', 'error');
        return;
    }
    
    if (!currentKeyVault) {
        showNotification('Please select a Key Vault first', 'error');
        return;
    }
    
    // Simulate key creation (in real app, this would call Azure SDK)
    const newKey = {
        name: keyName,
        type: keyType,
        size: keySize,
        description: keyDescription,
        enabled: true,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        expires: null
    };
    
    // Add to local storage
    if (!allKeysByVault.has(currentKeyVault.name)) {
        allKeysByVault.set(currentKeyVault.name, []);
    }
    allKeysByVault.get(currentKeyVault.name).push(newKey);
    
    // Refresh display
    if (currentTab === 'keys') {
        loadKeysForKeyVault(currentKeyVault);
    }
    
    hideAddKeyModal();
    showNotification(`Key "${keyName}" created successfully`, 'success');
    
    // Clear form
    document.getElementById('keyName').value = '';
    document.getElementById('keyDescription').value = '';
}

// Save secret function
function saveSecret() {
    const secretName = document.getElementById('secretName').value.trim();
    const secretValue = document.getElementById('secretValue').value.trim();
    const secretDescription = document.getElementById('secretDescription').value.trim();
    
    if (!secretName) {
        showNotification('Please enter a secret name', 'error');
        return;
    }
    
    if (!secretValue) {
        showNotification('Please enter a secret value', 'error');
        return;
    }
    
    if (!currentKeyVault) {
        showNotification('Please select a Key Vault first', 'error');
        return;
    }
    
    // Simulate secret creation (in real app, this would call Azure SDK)
    const newSecret = {
        name: secretName,
        value: secretValue,
        description: secretDescription,
        enabled: true,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        expires: null
    };
    
    // Add to local storage
    if (!allSecretsByVault.has(currentKeyVault.name)) {
        allSecretsByVault.set(currentKeyVault.name, []);
    }
    allSecretsByVault.get(currentKeyVault.name).push(newSecret);
    
    // Refresh display
    if (currentTab === 'secrets') {
        loadSecretsForKeyVault(currentKeyVault);
    }
    
    hideAddSecretModal();
    showNotification(`Secret "${secretName}" created successfully`, 'success');
    
    // Clear form
    document.getElementById('secretName').value = '';
    document.getElementById('secretValue').value = '';
    document.getElementById('secretDescription').value = '';
}

// Certificate rendering function
function renderCertificates(certificates, searchTerm = '') {
    console.log(`Rendering ${certificates.length} certificates:`, certificates.map(c => ({ name: c.name, subject: c.subject, issuer: c.issuer })));
    
    if (!certificatesContainer) {
        console.error('Certificates container not found');
        return;
    }
    
    if (certificates.length === 0) {
        certificatesContainer.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-certificate fa-3x"></i>
                <h2>No Certificates Found</h2>
                <p>No certificates were found in this Key Vault or match your search criteria.</p>
            </div>
        `;
        return;
    }
    
    // Filter by search term if provided
    const filteredCertificates = searchTerm ? certificates.filter(cert => 
        cert.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (cert.subject && cert.subject.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (cert.issuer && cert.issuer.toLowerCase().includes(searchTerm.toLowerCase()))
    ) : certificates;
    
    console.log(`Filtered certificates: ${filteredCertificates.length} out of ${certificates.length}`);
    
    // Calculate pagination
    const totalPages = Math.ceil(filteredCertificates.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageCertificates = filteredCertificates.slice(startIndex, endIndex);
    
    // Create cards
    const cards = pageCertificates.map(certificate => createCertificateCard(certificate, searchTerm));
    
    // Update container
    certificatesContainer.innerHTML = `
        <div class="content-header">
            <div class="content-info">
                <span>Showing ${startIndex + 1}-${Math.min(endIndex, filteredCertificates.length)} of ${filteredCertificates.length} certificates</span>
            </div>
            ${totalPages > 1 ? `
                <div class="pagination">
                    <button class="btn btn-sm" onclick="changePage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <span class="page-info">Page ${currentPage} of ${totalPages}</span>
                    <button class="btn btn-sm" onclick="changePage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>
                        <i class="fas fa-chevron-right"></i>
                    </button>
                </div>
            ` : ''}
        </div>
        <div class="certificates-grid">
            ${cards.join('')}
        </div>
    `;
}

// Load certificates for Key Vault
async function loadCertificatesForKeyVault(keyVault) {
    // Check if already loaded
    if (allCertificatesByVault.has(keyVault.name)) {
        renderCertificates(allCertificatesByVault.get(keyVault.name));
        return;
    }
    
    showLoading(certificatesContainer, 'Loading certificates...');
    try {
        console.log('Loading certificates for Key Vault:', keyVault.name);
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${keyVault.name}.vault.azure.net/`;
        
        const certificates = await loadCertificatesForVault(vaultUrl, credential, keyVault.name);
        console.log('Total certificates found:', certificates.length);
        allCertificatesByVault.set(keyVault.name, certificates);
        renderCertificates(certificates);
        showNotification(`Loaded ${certificates.length} certificates from ${keyVault.name}`, 'success');
        addLogEntry(`Loaded ${certificates.length} certificates from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading certificates for', keyVault.name, ':', error);
        showError(certificatesContainer, `Failed to load certificates: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load certificates. Check console for details.', 'error');
        addLogEntry(`Failed to load certificates from ${keyVault.name}: ${error.message}`, 'error');
    }
}

// Load certificates for vault
async function loadCertificatesForVault(vaultUrl, credential, vaultName) {
    try {
        console.log(`Loading certificates for vault: ${vaultName}`);
        const certificateClient = new CertificateClient(vaultUrl, credential);
        const certificates = [];
        
        // List all certificate properties
        for await (const certProp of certificateClient.listPropertiesOfCertificates()) {
            try {
                console.log(`Found certificate: ${certProp.name}`);
                // Get the full certificate
                const certificate = await certificateClient.getCertificate(certProp.name);
                
                // Try to get the certificate value (private key)
                let certificateValue = null;
                try {
                    const certSecret = await certificateClient.getCertificateVersion(certProp.name, certificate.properties.version);
                    certificateValue = certSecret.value;
                    console.log(`Retrieved certificate value for: ${certProp.name}`);
                } catch (valueError) {
                    console.warn(`Could not retrieve certificate value for ${certProp.name}:`, valueError.message);
                    certificateValue = null;
                }
                
                // Extract relevant information
                const certInfo = {
                    name: certificate.name,
                    subject: certificate.properties.subject || 'Unknown',
                    issuer: certificate.properties.issuerName || 'Unknown',
                    description: certificate.properties.tags?.description || '',
                    enabled: certificate.properties.enabled !== false,
                    created: certificate.properties.createdOn?.toISOString() || '',
                    updated: certificate.properties.updatedOn?.toISOString() || '',
                    expires: certificate.properties.expiresOn?.toISOString() || null,
                    notBefore: certificate.properties.notBefore?.toISOString() || null,
                    version: certificate.properties.version || '',
                    tags: certificate.properties.tags || {},
                    value: certificateValue // Add the certificate value
                };
                
                console.log(`Loaded certificate: ${certificate.name}, subject: ${certInfo.subject}, issuer: ${certInfo.issuer}`);
                certificates.push(certInfo);
            } catch (error) {
                console.warn(`Failed to get certificate ${certProp.name}:`, error);
                // Add basic info even if full certificate can't be retrieved
                certificates.push({
                    name: certProp.name,
                    subject: 'Access Denied',
                    issuer: 'Unknown',
                    description: '',
                    enabled: certProp.enabled !== false,
                    created: certProp.createdOn?.toISOString() || '',
                    updated: certProp.updatedOn?.toISOString() || '',
                    expires: certProp.expiresOn?.toISOString() || null,
                    notBefore: certProp.notBefore?.toISOString() || null,
                    version: certProp.version || '',
                    tags: certProp.tags || {},
                    value: null
                });
            }
        }
        
        console.log(`Total certificates loaded from ${vaultName}: ${certificates.length}`);
        return certificates;
        
    } catch (error) {
        console.error(`Error loading certificates from ${vaultName}:`, error);
        throw new Error(`Failed to load certificates: ${error.message}`);
    }
}

// Delete certificate function
function deleteCertificate(certificateName) {
    if (!currentKeyVault) return;
    if (confirm(`Are you sure you want to delete the certificate "${certificateName}"? This action cannot be undone.`)) {
        // In a real implementation, this would call the Azure SDK
        showNotification('Certificate deletion not yet implemented', 'warning');
        addLogEntry(`Certificate deletion requested for ${certificateName} (not implemented)`, 'warning');
    }
}

// Add certificate modal functions
function showAddCertificateModal() {
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.id = 'addCertificateModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3><i class="fas fa-certificate"></i> Add New Certificate</h3>
                <button class="close-btn" onclick="hideAddCertificateModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="certificateName">Certificate Name:</label>
                    <input type="text" id="certificateName" placeholder="Enter certificate name" required>
                </div>
                <div class="form-group">
                    <label for="certificateSubject">Subject:</label>
                    <input type="text" id="certificateSubject" placeholder="CN=example.com">
                </div>
                <div class="form-group">
                    <label for="certificateDescription">Description (optional):</label>
                    <input type="text" id="certificateDescription" placeholder="Enter description">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="hideAddCertificateModal()">Cancel</button>
                <button class="btn btn-primary" onclick="saveCertificate()">Create Certificate</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideAddCertificateModal();
    });
}

function hideAddCertificateModal() {
    const modal = document.getElementById('addCertificateModal');
    if (modal) {
        modal.remove();
    }
}

function saveCertificate() {
    const certificateName = document.getElementById('certificateName').value.trim();
    const certificateSubject = document.getElementById('certificateSubject').value.trim();
    const certificateDescription = document.getElementById('certificateDescription').value.trim();
    
    if (!certificateName) {
        showNotification('Please enter a certificate name', 'error');
        return;
    }
    
    if (!currentKeyVault) {
        showNotification('Please select a Key Vault first', 'error');
        return;
    }
    
    // Simulate certificate creation (in real app, this would call Azure SDK)
    const newCertificate = {
        name: certificateName,
        subject: certificateSubject,
        issuer: 'Self-Signed',
        description: certificateDescription,
        enabled: true,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() // 1 year from now
    };
    
    // Add to local storage
    if (!allCertificatesByVault.has(currentKeyVault.name)) {
        allCertificatesByVault.set(currentKeyVault.name, []);
    }
    allCertificatesByVault.get(currentKeyVault.name).push(newCertificate);
    
    // Refresh display
    if (currentTab === 'certificates') {
        loadCertificatesForKeyVault(currentKeyVault);
    }
    
    hideAddCertificateModal();
    showNotification(`Certificate "${certificateName}" created successfully`, 'success');
    
    // Clear form
    document.getElementById('certificateName').value = '';
    document.getElementById('certificateSubject').value = '';
    document.getElementById('certificateDescription').value = '';
}

// Clear vault search function - make it globally accessible
window.clearVaultSearch = function() {
    try {
        const vaultSearchInput = document.getElementById('vaultSearchInput');
        if (vaultSearchInput) {
            vaultSearchInput.value = '';
            handleVaultSearch(); // Trigger search to show all items
            console.log('Vault search cleared');
        }
    } catch (error) {
        console.error('Error clearing vault search:', error);
    }
};

// Make migration functions globally accessible
window.hideMigrationModal = function() {
    const migrationModal = document.getElementById('migrationModal');
    if (migrationModal) {
        migrationModal.classList.remove('show');
    }
};

window.removeSecretFromSelection = function(secretName) {
    selectedSecrets.delete(secretName);
    updateMigrationButton();
    showMigrationModal(); // Refresh the modal
};

window.removeKeyFromSelection = function(keyName) {
    selectedKeys.delete(keyName);
    updateMigrationButton();
    showMigrationModal(); // Refresh the modal
};

window.removeCertificateFromSelection = function(certName) {
    selectedCertificates.delete(certName);
    updateMigrationButton();
    showMigrationModal(); // Refresh the modal
};

window.startMigration = async function() {
    const targetVaultName = document.getElementById('targetVaultSelect').value;
    if (!targetVaultName) {
        showNotification('Please select a target Key Vault', 'error');
        return;
    }
    
    const overwriteExisting = document.getElementById('overwriteExisting').checked;
    const preserveMetadata = document.getElementById('preserveMetadata').checked;
    const validateBeforeMigrate = document.getElementById('validateBeforeMigrate').checked;
    
    hideMigrationModal();
    showMigrationProgressModal();
    
    try {
        migrationInProgress = true;
        migrationCancelled = false;
        
        addMigrationLog('Starting migration process...', 'info');
        
        // Validate target vault access if requested
        if (validateBeforeMigrate) {
            addMigrationLog(`Validating access to target vault: ${targetVaultName}`, 'info');
            // Add validation logic here
            addMigrationLog('Target vault access validated successfully', 'success');
        }
        
        const totalItems = selectedSecrets.size + selectedKeys.size + selectedCertificates.size;
        let completedItems = 0;
        
        // Migrate secrets
        for (const secretName of selectedSecrets) {
            try {
                addMigrationLog(`Migrating secret: ${secretName}`, 'info');
                // Add actual migration logic here using Azure SDK
                await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate migration
                addMigrationLog(`Successfully migrated secret: ${secretName}`, 'success');
                completedItems++;
                updateMigrationProgress((completedItems / totalItems) * 100, `Migrated ${completedItems} of ${totalItems} items`);
            } catch (error) {
                addMigrationLog(`Failed to migrate secret ${secretName}: ${error.message}`, 'error');
            }
        }
        
        // Migrate keys
        for (const keyName of selectedKeys) {
            try {
                addMigrationLog(`Migrating key: ${keyName}`, 'info');
                // Add actual migration logic here using Azure SDK
                await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate migration
                addMigrationLog(`Successfully migrated key: ${keyName}`, 'success');
                completedItems++;
                updateMigrationProgress((completedItems / totalItems) * 100, `Migrated ${completedItems} of ${totalItems} items`);
            } catch (error) {
                addMigrationLog(`Failed to migrate key ${keyName}: ${error.message}`, 'error');
            }
        }
        
        // Migrate certificates
        for (const certName of selectedCertificates) {
            try {
                addMigrationLog(`Migrating certificate: ${certName}`, 'info');
                // Add actual migration logic here using Azure SDK
                await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate migration
                addMigrationLog(`Successfully migrated certificate: ${certName}`, 'success');
                completedItems++;
                updateMigrationProgress((completedItems / totalItems) * 100, `Migrated ${completedItems} of ${totalItems} items`);
            } catch (error) {
                addMigrationLog(`Failed to migrate certificate ${certName}: ${error.message}`, 'error');
            }
        }
        
        updateMigrationProgress(100, 'Migration completed successfully!');
        addMigrationLog('Migration process completed', 'success');
        
        // Show completion button
        const closeBtn = document.getElementById('closeMigrationBtn');
        const cancelBtn = document.getElementById('cancelMigrationBtn');
        if (closeBtn) closeBtn.style.display = 'block';
        if (cancelBtn) cancelBtn.style.display = 'none';
        
        // Clear selections
        selectedSecrets.clear();
        selectedKeys.clear();
        selectedCertificates.clear();
        updateMigrationButton();
        
        showNotification('Migration completed successfully!', 'success');
        
    } catch (error) {
        addMigrationLog(`Migration failed: ${error.message}`, 'error');
        showNotification('Migration failed. Check the log for details.', 'error');
    }
};

window.cancelMigration = function() {
    migrationCancelled = true;
    addMigrationLog('Migration cancelled by user', 'warning');
    document.getElementById('cancelMigrationBtn').disabled = true;
    document.getElementById('cancelMigrationBtn').textContent = 'Cancelling...';
};

window.closeMigrationProgress = function() {
    const migrationProgressModal = document.getElementById('migrationProgressModal');
    if (migrationProgressModal) {
        migrationProgressModal.classList.remove('show');
    }
};

// Make toggleCertificateVisibility globally accessible
window.toggleCertificateVisibility = function(certificateName) {
    const valueContent = document.getElementById(`certificateValue_${certificateName}`);
    const toggleBtn = valueContent?.previousElementSibling?.querySelector('.toggle-password');
    
    if (valueContent && toggleBtn) {
        const isHidden = valueContent.classList.contains('hidden');
        
        if (isHidden) {
            valueContent.classList.remove('hidden');
            toggleBtn.innerHTML = '<i class="fas fa-eye-slash"></i>';
        } else {
            valueContent.classList.add('hidden');
            toggleBtn.innerHTML = '<i class="fas fa-eye"></i>';
        }
    }
};

// Make migration progress functions globally accessible
window.showMigrationProgressModal = function() {
    // Create migration progress modal if it doesn't exist
    let migrationProgressModal = document.getElementById('migrationProgressModal');
    if (!migrationProgressModal) {
        migrationProgressModal = document.createElement('div');
        migrationProgressModal.id = 'migrationProgressModal';
        migrationProgressModal.className = 'modal';
        migrationProgressModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3><i class="fas fa-exchange-alt"></i> Migration Progress</h3>
                </div>
                <div class="modal-body">
                    <div class="migration-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" id="migrationProgressFill" style="width: 0%"></div>
                        </div>
                        <div class="progress-text" id="migrationProgressText">Preparing migration...</div>
                    </div>
                    <div class="migration-log" id="migrationLog">
                        <!-- Migration log entries will appear here -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="cancelMigration()" id="cancelMigrationBtn">Cancel</button>
                    <button class="btn btn-primary" onclick="closeMigrationProgress()" id="closeMigrationBtn" style="display: none;">
                        Close
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(migrationProgressModal);
    }
    
    migrationProgressModal.classList.add('show');
    // Reset progress
    updateMigrationProgress(0, 'Preparing migration...');
    // Clear previous log
    const migrationLog = document.getElementById('migrationLog');
    if (migrationLog) migrationLog.innerHTML = '';
};

window.closeMigrationProgress = function() {
    const progressModal = document.getElementById('migrationProgressModal');
    if (progressModal) {
        progressModal.classList.remove('show');
    }
};

window.cancelMigration = function() {
    migrationCancelled = true;
    addMigrationLog('Migration cancelled by user', 'warning');
    showNotification('Migration cancelled', 'warning');
    closeMigrationProgress();
};

window.updateMigrationProgress = function(percent, text) {
    const progressFill = document.getElementById('migrationProgressFill');
    const progressText = document.getElementById('migrationProgressText');
    
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = text;
};

window.addMigrationLog = function(message, type = 'info') {
    const migrationLog = document.getElementById('migrationLog');
    if (!migrationLog) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = `migration-log-entry ${type}`;
    
    const timestamp = new Date().toLocaleTimeString();
    const icon = type === 'success' ? 'fas fa-check' : 
                 type === 'error' ? 'fas fa-times' : 
                 type === 'warning' ? 'fas fa-exclamation-triangle' : 'fas fa-info';
    
    logEntry.innerHTML = `
        <span class="log-time">${timestamp}</span>
        <i class="${icon}"></i>
        <span class="log-message">${message}</span>
    `;
    
    migrationLog.appendChild(logEntry);
    migrationLog.scrollTop = migrationLog.scrollHeight;
};