const { ipcRenderer } = require('electron');
const { DefaultAzureCredential } = require('@azure/identity');
const { KeyVaultManagementClient } = require('@azure/arm-keyvault');
const { SecretClient } = require('@azure/keyvault-secrets');
const { KeyClient } = require('@azure/keyvault-keys');
const { SubscriptionClient } = require('@azure/arm-subscriptions');
const fs = require('fs');
const path = require('path');

// Global state
let allKeyVaults = [];
let allSecretsByVault = {}; // { vaultName: [secrets] }
let allKeysByVault = {};    // { vaultName: [keys] }
let currentKeyVault = null;
let globalSearchResults = [];
let currentTab = 'secrets';

// DOM elements
const keyvaultList = document.getElementById('keyvaultList');
const secretsContainer = document.getElementById('secretsContainer');
const keysContainer = document.getElementById('keysContainer');
const mainHeader = document.getElementById('mainHeader');
const globalSearchInput = document.getElementById('globalSearchInput');
const clearGlobalSearchBtn = document.getElementById('clearGlobalSearch');
const refreshKeyVaultsBtn = document.getElementById('refreshKeyVaults');
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
    await loadAllKeyVaults();
});

function setupEventListeners() {
    refreshKeyVaultsBtn.addEventListener('click', loadAllKeyVaults);
    globalSearchInput.addEventListener('input', handleGlobalSearch);
    clearGlobalSearchBtn.addEventListener('click', clearGlobalSearch);
    
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

// Fetch all subscriptions, then all Key Vaults across all subscriptions
async function loadAllKeyVaults() {
    showLoading(keyvaultList, 'Loading Key Vaults...');
    allKeyVaults = [];
    allSecretsByVault = {};
    allKeysByVault = {};
    try {
        console.log('Starting to load Key Vaults...');
        const credential = new DefaultAzureCredential();
        console.log('Credential created successfully');
        
        const subscriptionClient = new SubscriptionClient(credential);
        console.log('Subscription client created');
        
        const subscriptions = [];
        console.log('Fetching subscriptions...');
        for await (const sub of subscriptionClient.subscriptions.list()) {
            console.log('Found subscription:', sub.displayName, sub.subscriptionId);
            subscriptions.push(sub);
        }
        console.log('Total subscriptions found:', subscriptions.length);
        
        if (subscriptions.length === 0) {
            showError(keyvaultList, 'No subscriptions found. Please check your Azure account and permissions.');
            return;
        }
        
        // For each subscription, get Key Vaults
        for (const sub of subscriptions) {
            console.log('Fetching Key Vaults for subscription:', sub.displayName);
            try {
                const kvClient = new KeyVaultManagementClient(credential, sub.subscriptionId);
                for await (const vault of kvClient.vaults.list()) {
                    console.log('Found Key Vault:', vault.name, 'in', vault.location);
                    allKeyVaults.push({
                        id: vault.id,
                        name: vault.name,
                        location: vault.location,
                        resourceGroup: vault.resourceGroup,
                        subscriptionId: sub.subscriptionId,
                        properties: vault.properties
                    });
                }
            } catch (error) {
                console.error('Error fetching Key Vaults for subscription', sub.displayName, ':', error);
                showNotification(`Warning: Could not load Key Vaults for subscription "${sub.displayName}"`, 'warning');
            }
        }
        
        console.log('Total Key Vaults found:', allKeyVaults.length);
        renderKeyVaults(allKeyVaults);
        
    } catch (error) {
        console.error('Error loading Key Vaults:', error);
        showError(keyvaultList, `Failed to load Key Vaults: ${error.message}. Please check your Azure credentials and permissions.`);
        showNotification('Failed to load Key Vaults. Check console for details.', 'error');
    }
}

function renderKeyVaults(keyVaults) {
    keyvaultList.innerHTML = '';
    if (keyVaults.length === 0) {
        keyvaultList.innerHTML = '<div class="loading">No Key Vaults found</div>';
        return;
    }
    keyVaults.forEach(kv => {
        const kvElement = document.createElement('div');
        kvElement.className = 'keyvault-item';
        kvElement.textContent = kv.name + (kv.location ? ` (${kv.location})` : '');
        kvElement.dataset.keyvaultName = kv.name;
        kvElement.addEventListener('click', () => selectKeyVault(kv));
        keyvaultList.appendChild(kvElement);
    });
}

async function selectKeyVault(keyVault) {
    document.querySelectorAll('.keyvault-item').forEach(item => item.classList.remove('active'));
    document.querySelector(`[data-keyvault-name="${keyVault.name}"]`).classList.add('active');
    currentKeyVault = keyVault;
    globalSearchInput.value = '';
    
    // Load content based on current tab
    if (currentTab === 'secrets') {
        await loadSecretsForKeyVault(keyVault);
    } else if (currentTab === 'keys') {
        await loadKeysForKeyVault(keyVault);
    }
    
    renderKeyVaultHeader(keyVault);
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

async function loadSecretsForKeyVault(keyVault) {
    showLoading(secretsContainer, 'Loading secrets...');
    try {
        console.log('Loading secrets for Key Vault:', keyVault.name);
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${keyVault.name}.vault.azure.net/`;
        console.log('Key Vault URL:', vaultUrl);
        
        const secretClient = new SecretClient(vaultUrl, credential);
        console.log('Secret client created');
        
        const secrets = [];
        console.log('Listing secret properties...');
        for await (const secretProp of secretClient.listPropertiesOfSecrets()) {
            console.log('Found secret property:', secretProp.name);
            try {
                const secret = await secretClient.getSecret(secretProp.name);
                console.log('Retrieved secret:', secret.name);
                secrets.push({
                    name: secret.name,
                    value: secret.value,
                    version: secret.properties.version,
                    created: secret.properties.createdOn,
                    updated: secret.properties.updatedOn,
                    expires: secret.properties.expiresOn,
                    enabled: secret.properties.enabled
                });
            } catch (error) {
                console.warn(`Failed to get secret ${secretProp.name}:`, error);
            }
        }
        console.log('Total secrets found:', secrets.length);
        allSecretsByVault[keyVault.name] = secrets;
        renderSecrets(secrets);
        showNotification(`Loaded ${secrets.length} secrets from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading secrets for', keyVault.name, ':', error);
        showError(secretsContainer, `Failed to load secrets: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load secrets. Check console for details.', 'error');
    }
}

async function loadKeysForKeyVault(keyVault) {
    showLoading(keysContainer, 'Loading keys...');
    try {
        console.log('Loading keys for Key Vault:', keyVault.name);
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${keyVault.name}.vault.azure.net/`;
        
        const keyClient = new KeyClient(vaultUrl, credential);
        console.log('Key client created');
        
        const keys = [];
        console.log('Listing key properties...');
        for await (const keyProp of keyClient.listPropertiesOfKeys()) {
            console.log('Found key property:', keyProp.name);
            try {
                const key = await keyClient.getKey(keyProp.name);
                console.log('Retrieved key:', key.name);
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
            } catch (error) {
                console.warn(`Failed to get key ${keyProp.name}:`, error);
            }
        }
        console.log('Total keys found:', keys.length);
        allKeysByVault[keyVault.name] = keys;
        renderKeys(keys);
        showNotification(`Loaded ${keys.length} keys from ${keyVault.name}`, 'success');
    } catch (error) {
        console.error('Error loading keys for', keyVault.name, ':', error);
        showError(keysContainer, `Failed to load keys: ${error.message}. Please check your Key Vault access policies.`);
        showNotification('Failed to load keys. Check console for details.', 'error');
    }
}

// Global search logic
async function handleGlobalSearch() {
    const searchTerm = globalSearchInput.value.toLowerCase().trim();
    if (!searchTerm) {
        if (currentKeyVault) {
            renderKeyVaultHeader(currentKeyVault);
            if (currentTab === 'secrets') {
                renderSecrets(allSecretsByVault[currentKeyVault.name] || []);
            } else {
                renderKeys(allKeysByVault[currentKeyVault.name] || []);
            }
        } else {
            showWelcomeMessage();
        }
        return;
    }
    
    showLoading(currentTab === 'secrets' ? secretsContainer : keysContainer, 'Searching across all Key Vaults...');
    mainHeader.innerHTML = `<h2><i class="fas fa-search"></i> Global Search Results</h2>`;
    
    // Fetch data for all vaults if not already loaded
    for (const kv of allKeyVaults) {
        if (!allSecretsByVault[kv.name]) {
            await loadSecretsForKeyVault(kv);
        }
        if (!allKeysByVault[kv.name]) {
            await loadKeysForKeyVault(kv);
        }
    }
    
    // Search all secrets and keys
    const searchResults = [];
    
    // Search secrets
    for (const [vaultName, secrets] of Object.entries(allSecretsByVault)) {
        for (const secret of secrets) {
            if (fuzzySearch(secret.name.toLowerCase(), searchTerm)) {
                searchResults.push({ ...secret, vaultName, type: 'secret' });
            }
        }
    }
    
    // Search keys
    for (const [vaultName, keys] of Object.entries(allKeysByVault)) {
        for (const key of keys) {
            if (fuzzySearch(key.name.toLowerCase(), searchTerm)) {
                searchResults.push({ ...key, vaultName, type: 'key' });
            }
        }
    }
    
    renderGlobalSearchResults(searchResults, searchTerm);
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

function clearGlobalSearch() {
    globalSearchInput.value = '';
    if (currentKeyVault) {
        renderKeyVaultHeader(currentKeyVault);
        if (currentTab === 'secrets') {
            renderSecrets(allSecretsByVault[currentKeyVault.name] || []);
        } else {
            renderKeys(allKeysByVault[currentKeyVault.name] || []);
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
    secrets.forEach(secret => {
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
    keys.forEach(key => {
        const keyCard = createKeyCard(key);
        keysContainer.appendChild(keyCard);
    });
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

// Fuzzy search implementation
function fuzzySearch(text, pattern) {
    let patternIndex = 0;
    for (let i = 0; i < text.length && patternIndex < pattern.length; i++) {
        if (text[i] === pattern[patternIndex]) {
            patternIndex++;
        }
    }
    return patternIndex === pattern.length;
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
            data.secrets = allSecretsByVault[currentKeyVault.name] || [];
            if (!includeValues) {
                data.secrets = data.secrets.map(secret => ({
                    ...secret,
                    value: '[REDACTED]'
                }));
            }
        }
        
        if (type === 'keys' || type === 'all') {
            data.keys = allKeysByVault[currentKeyVault.name] || [];
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
        (allSecretsByVault[currentKeyVault.name] || []) : 
        (allKeysByVault[currentKeyVault.name] || []);
    
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