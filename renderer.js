const { ipcRenderer } = require('electron');
const { DefaultAzureCredential } = require('@azure/identity');
const { KeyVaultManagementClient } = require('@azure/arm-keyvault');
const { SecretClient } = require('@azure/keyvault-secrets');
const { SubscriptionClient } = require('@azure/arm-subscriptions');

// Global state
let allKeyVaults = [];
let allSecretsByVault = {}; // { vaultName: [secrets] }
let allKeysByVault = {};    // { vaultName: [keys] } // (future)
let currentKeyVault = null;
let globalSearchResults = [];

// DOM elements
const keyvaultList = document.getElementById('keyvaultList');
const secretsContainer = document.getElementById('secretsContainer');
const mainHeader = document.getElementById('mainHeader');
const globalSearchInput = document.getElementById('globalSearchInput');
const clearGlobalSearchBtn = document.getElementById('clearGlobalSearch');
const refreshKeyVaultsBtn = document.getElementById('refreshKeyVaults');
const addSecretBtn = document.getElementById('addSecret');
const addSecretModal = document.getElementById('addSecretModal');
const closeModalBtn = document.getElementById('closeModal');
const cancelAddBtn = document.getElementById('cancelAdd');
const saveSecretBtn = document.getElementById('saveSecret');

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await loadAllKeyVaults();
});

function setupEventListeners() {
    refreshKeyVaultsBtn.addEventListener('click', loadAllKeyVaults);
    globalSearchInput.addEventListener('input', handleGlobalSearch);
    clearGlobalSearchBtn.addEventListener('click', clearGlobalSearch);
    addSecretBtn && addSecretBtn.addEventListener('click', showAddSecretModal);
    closeModalBtn && closeModalBtn.addEventListener('click', hideAddSecretModal);
    cancelAddBtn && cancelAddBtn.addEventListener('click', hideAddSecretModal);
    saveSecretBtn && saveSecretBtn.addEventListener('click', saveSecret);
    addSecretModal && addSecretModal.addEventListener('click', (e) => {
        if (e.target === addSecretModal) hideAddSecretModal();
    });
}

// Fetch all subscriptions, then all Key Vaults across all subscriptions
async function loadAllKeyVaults() {
    showLoading(keyvaultList, 'Loading Key Vaults...');
    allKeyVaults = [];
    allSecretsByVault = {};
    allKeysByVault = {};
    try {
        const credential = new DefaultAzureCredential();
        const subscriptionClient = new SubscriptionClient(credential);
        const subscriptions = [];
        for await (const sub of subscriptionClient.subscriptions.list()) {
            subscriptions.push(sub);
        }
        // For each subscription, get Key Vaults
        for (const sub of subscriptions) {
            const kvClient = new KeyVaultManagementClient(credential, sub.subscriptionId);
            for await (const vault of kvClient.vaults.list()) {
                allKeyVaults.push({
                    id: vault.id,
                    name: vault.name,
                    location: vault.location,
                    resourceGroup: vault.resourceGroup,
                    subscriptionId: sub.subscriptionId,
                    properties: vault.properties
                });
            }
        }
        renderKeyVaults(allKeyVaults);
    } catch (error) {
        console.error('Error loading Key Vaults:', error);
        showError(keyvaultList, 'Failed to load Key Vaults. Please check your Azure credentials and permissions.');
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
    await loadSecretsForKeyVault(keyVault);
    renderKeyVaultHeader(keyVault);
}

function renderKeyVaultHeader(keyVault) {
    mainHeader.innerHTML = `<h2><i class="fas fa-vault"></i> ${keyVault.name}</h2>
        <div class="header-actions">
            <button class="btn btn-primary" id="refreshSecrets"> <i class="fas fa-sync"></i> Refresh </button>
            <button class="btn btn-success" id="addSecret"> <i class="fas fa-plus"></i> Add Secret </button>
        </div>`;
    document.getElementById('refreshSecrets').addEventListener('click', () => loadSecretsForKeyVault(keyVault));
    document.getElementById('addSecret').addEventListener('click', showAddSecretModal);
}

async function loadSecretsForKeyVault(keyVault) {
    showLoading(secretsContainer, 'Loading secrets...');
    try {
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${keyVault.name}.vault.azure.net/`;
        const secretClient = new SecretClient(vaultUrl, credential);
        const secrets = [];
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
            } catch (error) {
                // skip secrets we can't fetch
            }
        }
        allSecretsByVault[keyVault.name] = secrets;
        renderSecrets(secrets);
    } catch (error) {
        console.error('Error loading secrets:', error);
        showError(secretsContainer, 'Failed to load secrets.');
    }
}

// Global search logic
async function handleGlobalSearch() {
    const searchTerm = globalSearchInput.value.toLowerCase().trim();
    if (!searchTerm) {
        if (currentKeyVault) {
            renderKeyVaultHeader(currentKeyVault);
            renderSecrets(allSecretsByVault[currentKeyVault.name] || []);
        } else {
            showWelcomeMessage();
        }
        return;
    }
    showLoading(secretsContainer, 'Searching across all Key Vaults...');
    mainHeader.innerHTML = `<h2><i class="fas fa-search"></i> Global Search Results</h2>`;
    // Fetch secrets for all vaults if not already loaded
    for (const kv of allKeyVaults) {
        if (!allSecretsByVault[kv.name]) {
            await loadSecretsForKeyVault(kv);
        }
    }
    // Search all secrets
    globalSearchResults = [];
    for (const [vaultName, secrets] of Object.entries(allSecretsByVault)) {
        for (const secret of secrets) {
            if (fuzzySearch(secret.name.toLowerCase(), searchTerm)) {
                globalSearchResults.push({ ...secret, vaultName });
            }
        }
    }
    renderGlobalSearchResults(globalSearchResults, searchTerm);
}

function renderGlobalSearchResults(results, searchTerm) {
    secretsContainer.innerHTML = '';
    if (results.length === 0) {
        secretsContainer.innerHTML = `<div class="welcome-message"><i class="fas fa-search fa-3x"></i><h2>No results found</h2><p>No secrets or keys matching "${searchTerm}" were found in any Key Vault.</p></div>`;
        return;
    }
    // Group by vault
    const grouped = {};
    for (const result of results) {
        if (!grouped[result.vaultName]) grouped[result.vaultName] = [];
        grouped[result.vaultName].push(result);
    }
    for (const [vaultName, secrets] of Object.entries(grouped)) {
        const groupHeader = document.createElement('h3');
        groupHeader.innerHTML = `<i class="fas fa-vault"></i> ${vaultName}`;
        secretsContainer.appendChild(groupHeader);
        secrets.forEach(secret => {
            const secretCard = createSecretCard(secret);
            secretsContainer.appendChild(secretCard);
        });
    }
}

function clearGlobalSearch() {
    globalSearchInput.value = '';
    if (currentKeyVault) {
        renderKeyVaultHeader(currentKeyVault);
        renderSecrets(allSecretsByVault[currentKeyVault.name] || []);
    } else {
        showWelcomeMessage();
    }
}

function renderSecrets(secrets) {
    secretsContainer.innerHTML = '';
    if (secrets.length === 0) {
        secretsContainer.innerHTML = `<div class="welcome-message"><i class="fas fa-search fa-3x"></i><h2>No secrets found</h2><p>This Key Vault has no secrets.</p></div>`;
        return;
    }
    secrets.forEach(secret => {
        const secretCard = createSecretCard(secret);
        secretsContainer.appendChild(secretCard);
    });
}

function showWelcomeMessage() {
    secretsContainer.innerHTML = `<div class="welcome-message"><i class="fas fa-key fa-3x"></i><h2>Welcome to Azure Secrets Explorer</h2><p>Select a Key Vault or use global search to start exploring your secrets and keys</p></div>`;
}

function showLoading(container, message) {
    container.innerHTML = `<div class="loading"><div class="loading-spinner"></div>${message}</div>`;
}

function showError(container, message) {
    container.innerHTML = `<div class="error"><i class="fas fa-exclamation-triangle"></i>${message}</div>`;
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

// Modal and utility functions (unchanged, as before)
function showAddSecretModal() {
    addSecretModal.classList.add('show');
}
function hideAddSecretModal() {
    addSecretModal.classList.remove('show');
    document.getElementById('secretName').value = '';
    document.getElementById('secretValue').value = '';
    document.getElementById('secretDescription').value = '';
}
async function saveSecret() {
    const name = document.getElementById('secretName').value.trim();
    const value = document.getElementById('secretValue').value.trim();
    const description = document.getElementById('secretDescription').value.trim();
    if (!name || !value) {
        alert('Please fill in all required fields');
        return;
    }
    try {
        if (!currentKeyVault) return;
        const credential = new DefaultAzureCredential();
        const vaultUrl = `https://${currentKeyVault.name}.vault.azure.net/`;
        const secretClient = new SecretClient(vaultUrl, credential);
        await secretClient.setSecret(name, value, { tags: description ? { description } : undefined });
        await loadSecretsForKeyVault(currentKeyVault);
        hideAddSecretModal();
    } catch (error) {
        console.error('Error creating secret:', error);
        alert('Failed to create secret');
    }
}
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        const button = event.target.closest('button');
        const originalText = button.innerHTML;
        button.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => {
            button.innerHTML = originalText;
        }, 2000);
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
        });
    }
}
window.copyToClipboard = copyToClipboard;
window.togglePasswordVisibility = togglePasswordVisibility;
window.deleteSecret = deleteSecret;

// Create secret card (same as before)
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
                <div class="info-value">${secret.enabled ? 'Enabled' : 'Disabled'}</div>
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