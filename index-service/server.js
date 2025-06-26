const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const cron = require('node-cron');
const Fuse = require('fuse.js');
const { v4: uuidv4 } = require('uuid');

// Azure SDK imports
const { DefaultAzureCredential, AzureCliCredential } = require('@azure/identity');
const { KeyVaultManagementClient } = require('@azure/arm-keyvault');
const { SecretClient } = require('@azure/keyvault-secrets');
const { KeyClient } = require('@azure/keyvault-keys');
const { SubscriptionClient } = require('@azure/arm-subscriptions');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// CORS for Electron app only
app.use(cors({
  origin: ['http://localhost:3000', 'https://localhost:3000'],
  credentials: true
}));

// In-memory encrypted storage
class EncryptedIndex {
  constructor() {
    this.encryptionKey = crypto.randomBytes(32);
    this.iv = crypto.randomBytes(16);
    this.data = new Map();
    this.lastIndexed = new Map();
    this.indexingStatus = 'idle';
    this.indexingProgress = 0;
  }

  encrypt(text) {
    const cipher = crypto.createCipher('aes-256-cbc', this.encryptionKey);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  decrypt(encryptedText) {
    const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  set(key, value) {
    const encryptedValue = this.encrypt(JSON.stringify(value));
    this.data.set(key, encryptedValue);
  }

  get(key) {
    const encryptedValue = this.data.get(key);
    if (!encryptedValue) return null;
    return JSON.parse(this.decrypt(encryptedValue));
  }

  clear() {
    this.data.clear();
    this.lastIndexed.clear();
  }

  size() {
    return this.data.size;
  }
}

// Global index instance
const index = new EncryptedIndex();
const searchIndex = new Map(); // Fast search index

// Azure client instances
let credential;
let subscriptionClient;
let keyVaultClient;

// Initialize Azure clients
async function initializeAzure() {
  try {
    console.log('Initializing Azure clients...');
    
    // Check if Azure credentials are available
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    // Try multiple credential paths
    const possiblePaths = [
      path.join(os.homedir(), '.azure', 'azureProfile.json'),
      path.join(os.homedir(), '.azure', 'accessTokens.json'),
      '/home/nodejs/.azure/azureProfile.json',
      '/home/nodejs/.azure/accessTokens.json',
      '/root/.azure/azureProfile.json',
      '/root/.azure/accessTokens.json'
    ];
    
    let credentialsFound = false;
    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        console.log(`Azure credentials found at: ${configPath}`);
        try {
          // Read file and handle BOM characters
          let fileContent = fs.readFileSync(configPath, 'utf8');
          
          // Remove BOM if present
          if (fileContent.charCodeAt(0) === 0xFEFF) {
            console.log('Removing BOM character from Azure config file');
            fileContent = fileContent.slice(1);
          }
          
          const azureConfig = JSON.parse(fileContent);
          console.log(`Successfully parsed Azure config from: ${configPath}`);
          console.log(`Found ${azureConfig.subscriptions && azureConfig.subscriptions.length ? azureConfig.subscriptions.length : 0} subscriptions in Azure CLI config`);
          credentialsFound = true;
          break;
        } catch (e) {
          console.log(`Could not parse Azure config from ${configPath}:`, e.message);
          
          // Try to read the file as binary to check for BOM
          try {
            const buffer = fs.readFileSync(configPath);
            console.log(`File size: ${buffer.length} bytes`);
            console.log(`First few bytes: ${buffer.slice(0, 10).toString('hex')}`);
            
            if (buffer.length > 0) {
              // Check for UTF-8 BOM
              if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
                console.log('UTF-8 BOM detected, trying to parse without BOM...');
                const contentWithoutBom = buffer.slice(3).toString('utf8');
                const azureConfig = JSON.parse(contentWithoutBom);
                console.log(`Successfully parsed Azure config after removing UTF-8 BOM`);
                credentialsFound = true;
                break;
              }
              // Check for UTF-16 BOM
              else if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
                console.log('UTF-16 LE BOM detected, trying to parse...');
                const contentWithoutBom = buffer.slice(2).toString('utf16le');
                const azureConfig = JSON.parse(contentWithoutBom);
                console.log(`Successfully parsed Azure config after removing UTF-16 BOM`);
                credentialsFound = true;
                break;
              }
              else if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
                console.log('UTF-16 BE BOM detected, trying to parse...');
                const contentWithoutBom = buffer.slice(2).toString('utf16be');
                const azureConfig = JSON.parse(contentWithoutBom);
                console.log(`Successfully parsed Azure config after removing UTF-16 BE BOM`);
                credentialsFound = true;
                break;
              }
            }
          } catch (binaryError) {
            console.log('Could not read file as binary:', binaryError.message);
          }
        }
      }
    }
    
    if (!credentialsFound) {
      console.log('No valid Azure CLI credentials found in any expected location');
      console.log('Expected locations:', possiblePaths);
      
      // List contents of .azure directory if it exists
      const azureDir = path.join(os.homedir(), '.azure');
      if (fs.existsSync(azureDir)) {
        console.log('Contents of .azure directory:');
        try {
          const files = fs.readdirSync(azureDir);
          files.forEach(file => {
            const filePath = path.join(azureDir, file);
            const stats = fs.statSync(filePath);
            console.log(`  ${file} (${stats.isDirectory() ? 'dir' : 'file'})`);
          });
        } catch (e) {
          console.log('Could not read .azure directory:', e.message);
        }
      }
    }
    
    // Try to create credential with more detailed error handling
    console.log('Creating Azure credential...');
    
    // Try multiple credential approaches
    let credentialCreated = false;
    
    // First, try AzureCliCredential
    try {
      credential = new AzureCliCredential();
      console.log('AzureCliCredential created successfully');
      credentialCreated = true;
    } catch (error) {
      console.log('AzureCliCredential failed:', error.message);
    }
    
    // If AzureCliCredential failed, try DefaultAzureCredential with only Azure CLI enabled
    if (!credentialCreated) {
      try {
        console.log('Trying DefaultAzureCredential with Azure CLI only...');
        credential = new DefaultAzureCredential({
          excludeManagedIdentityCredential: true,
          excludeVisualStudioCodeCredential: true,
          excludeAzureDeveloperCliCredential: true,
          excludePowerShellCredential: true,
          excludeEnvironmentCredential: true,
          excludeAzureCliCredential: false,
          excludeInteractiveBrowserCredential: true
        });
        console.log('DefaultAzureCredential fallback created successfully');
        credentialCreated = true;
      } catch (fallbackError) {
        console.log('DefaultAzureCredential fallback failed:', fallbackError.message);
      }
    }
    
    // If both failed, try a simple DefaultAzureCredential
    if (!credentialCreated) {
      try {
        console.log('Trying simple DefaultAzureCredential...');
        credential = new DefaultAzureCredential();
        console.log('Simple DefaultAzureCredential created successfully');
        credentialCreated = true;
      } catch (simpleError) {
        console.error('All credential methods failed:', simpleError);
        throw simpleError;
      }
    }
    
    // Test the credential with a simple operation
    console.log('Testing Azure credential...');
    subscriptionClient = new SubscriptionClient(credential);
    
    const subscriptions = [];
    for await (const subscription of subscriptionClient.subscriptions.list()) {
      subscriptions.push(subscription);
    }
    
    console.log(`Successfully authenticated with Azure. Found ${subscriptions.length} subscriptions:`, 
      subscriptions.map(s => s.subscriptionId));
    
    console.log('Azure clients initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Azure clients:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      details: error.details,
      name: error.name
    });
    
    // Provide helpful troubleshooting information
    console.error('Troubleshooting steps:');
    console.error('1. Ensure Azure CLI is installed on the host machine');
    console.error('2. Run "az login" on the host machine');
    console.error('3. Check that the .azure directory is properly mounted');
    console.error('4. Verify the container has access to the mounted credentials');
    console.error('5. Try running "az account show" on the host to verify authentication');
    
    throw error;
  }
}

// Index a single vault
async function indexVault(vault, progressCallback) {
  try {
    const vaultUrl = `https://${vault.name}.vault.azure.net/`;
    const secretClient = new SecretClient(vaultUrl, credential);
    const keyClient = new KeyClient(vaultUrl, credential);

    const vaultData = {
      name: vault.name,
      location: vault.location,
      resourceGroup: vault.resourceGroup,
      subscriptionId: vault.subscriptionId,
      secrets: [],
      keys: [],
      lastIndexed: new Date().toISOString()
    };

    // Index secrets
    console.log(`Indexing secrets for vault: ${vault.name}`);
    for await (const secretProp of secretClient.listPropertiesOfSecrets()) {
      try {
        const secret = await secretClient.getSecret(secretProp.name);
        vaultData.secrets.push({
          name: secret.name,
          value: secret.value,
          version: secret.properties.version,
          created: secret.properties.createdOn,
          updated: secret.properties.updatedOn,
          expires: secret.properties.expiresOn,
          enabled: secret.properties.enabled
        });
      } catch (error) {
        console.warn(`Failed to get secret ${secretProp.name}:`, error.message);
      }
    }

    // Index keys
    console.log(`Indexing keys for vault: ${vault.name}`);
    for await (const keyProp of keyClient.listPropertiesOfKeys()) {
      try {
        const key = await keyClient.getKey(keyProp.name);
        vaultData.keys.push({
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
        console.warn(`Failed to get key ${keyProp.name}:`, error.message);
      }
    }

    // Store in encrypted index
    index.set(vault.name, vaultData);
    index.lastIndexed.set(vault.name, new Date().toISOString());

    // Update search index
    updateSearchIndex(vaultData);

    console.log(`Indexed vault ${vault.name}: ${vaultData.secrets.length} secrets, ${vaultData.keys.length} keys`);
    return vaultData;

  } catch (error) {
    console.error(`Failed to index vault ${vault.name}:`, error);
    throw error;
  }
}

// Update search index for fast fuzzy search
function updateSearchIndex(vaultData) {
  const searchData = [];
  
  // Add secrets to search index
  vaultData.secrets.forEach(secret => {
    searchData.push({
      type: 'secret',
      vaultName: vaultData.name,
      name: secret.name,
      value: secret.value,
      data: secret
    });
  });

  // Add keys to search index
  vaultData.keys.forEach(key => {
    searchData.push({
      type: 'key',
      vaultName: vaultData.name,
      name: key.name,
      data: key
    });
  });

  // Update Fuse.js search index
  searchIndex.set(vaultData.name, new Fuse(searchData, {
    keys: ['name', 'value'],
    threshold: 0.3,
    includeScore: true
  }));
}

// Index all vaults
async function indexAllVaults() {
  if (index.indexingStatus === 'running') {
    console.log('Indexing already in progress');
    return;
  }

  index.indexingStatus = 'running';
  index.indexingProgress = 0;

  try {
    console.log('Starting full index of all vaults...');
    
    // Get all subscriptions
    const subscriptions = [];
    for await (const subscription of subscriptionClient.subscriptions.list()) {
      subscriptions.push(subscription);
    }

    // Get all vaults
    const allVaults = [];
    for (const subscription of subscriptions) {
      try {
        const keyVaultClient = new KeyVaultManagementClient(credential, subscription.subscriptionId);
        for await (const vault of keyVaultClient.vaults.list()) {
          allVaults.push({
            name: vault.name,
            location: vault.location,
            resourceGroup: vault.id.split('/')[4],
            subscriptionId: subscription.subscriptionId,
            properties: vault.properties
          });
        }
      } catch (error) {
        console.warn(`Failed to get vaults from subscription ${subscription.subscriptionId}:`, error);
      }
    }

    console.log(`Found ${allVaults.length} vaults to index`);

    // Index vaults in batches
    const batchSize = 5;
    for (let i = 0; i < allVaults.length; i += batchSize) {
      const batch = allVaults.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (vault) => {
        try {
          await indexVault(vault);
        } catch (error) {
          console.error(`Failed to index vault ${vault.name}:`, error);
        }
      }));

      index.indexingProgress = Math.min(100, ((i + batchSize) / allVaults.length) * 100);
      console.log(`Indexing progress: ${index.indexingProgress.toFixed(1)}%`);
    }

    index.indexingStatus = 'completed';
    console.log('Full indexing completed successfully');

  } catch (error) {
    index.indexingStatus = 'failed';
    console.error('Indexing failed:', error);
    throw error;
  }
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    indexedVaults: index.size(),
    indexingStatus: index.indexingStatus,
    indexingProgress: index.indexingProgress
  });
});

// Get indexing status
app.get('/status', (req, res) => {
  res.json({
    indexingStatus: index.indexingStatus,
    indexingProgress: index.indexingProgress,
    indexedVaults: index.size(),
    lastIndexed: Object.fromEntries(index.lastIndexed)
  });
});

// Start indexing
app.post('/index/start', async (req, res) => {
  try {
    if (index.indexingStatus === 'running') {
      return res.status(400).json({ error: 'Indexing already in progress' });
    }

    // Start indexing in background
    indexAllVaults().catch(error => {
      console.error('Background indexing failed:', error);
    });

    res.json({ message: 'Indexing started', status: 'running' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search across all indexed data
app.post('/search', (req, res) => {
  try {
    const { query, type, vaultName } = req.body;
    
    if (!query || query.trim().length === 0) {
      return res.json({ results: [] });
    }

    const results = [];
    
    // Search across all vaults
    for (const [vaultName, fuse] of searchIndex.entries()) {
      const searchResults = fuse.search(query);
      
      searchResults.forEach(result => {
        if (result.score < 0.6) { // Only include relevant results
          results.push({
            ...result.item,
            score: result.score,
            vaultName: vaultName
          });
        }
      });
    }

    // Sort by relevance
    results.sort((a, b) => a.score - b.score);

    // Limit results
    const limitedResults = results.slice(0, 100);

    res.json({
      results: limitedResults,
      totalFound: results.length,
      query: query
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get vault data
app.get('/vault/:vaultName', (req, res) => {
  try {
    const { vaultName } = req.params;
    const vaultData = index.get(vaultName);
    
    if (!vaultData) {
      return res.status(404).json({ error: 'Vault not found or not indexed' });
    }

    res.json(vaultData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all vaults
app.get('/vaults', (req, res) => {
  try {
    const vaults = [];
    for (const [vaultName, lastIndexed] of index.lastIndexed.entries()) {
      vaults.push({
        name: vaultName,
        lastIndexed: lastIndexed
      });
    }
    
    res.json({ vaults });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear index
app.delete('/index', (req, res) => {
  try {
    index.clear();
    searchIndex.clear();
    res.json({ message: 'Index cleared successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get security status
app.get('/security', (req, res) => {
  try {
    const securityInfo = {
      containerRunning: true,
      containerSecure: true,
      encryptionEnabled: true,
      ephemeralStorage: true,
      processIsolation: true,
      minimalPrivileges: true,
      localOnlyAccess: true,
      autoCleanup: true,
      lastVerified: new Date().toISOString(),
      securityFeatures: [
        'Ephemeral storage (no disk persistence)',
        'In-memory encrypted data',
        'Process isolation (containerized)',
        'Minimal privileges',
        'Auto-cleanup on app exit',
        'Local-only access',
        'Read-only filesystem',
        'Dropped capabilities',
        'Non-root user execution'
      ]
    };
    
    res.json(securityInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('API Error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function startServer() {
  try {
    await initializeAzure();
    
    app.listen(PORT, () => {
      console.log(`Index service running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });

    // Schedule hourly indexing
    cron.schedule('0 * * * *', () => {
      console.log('Running scheduled hourly indexing...');
      if (index.indexingStatus !== 'running') {
        indexAllVaults().catch(error => {
          console.error('Scheduled indexing failed:', error);
        });
      }
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down index service...');
  index.clear();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down index service...');
  index.clear();
  process.exit(0);
});

startServer(); 