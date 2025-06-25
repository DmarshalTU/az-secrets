const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { spawn, exec } = require('child_process');
const fs = require('fs');

// Initialize persistent storage
const store = new Store();

let mainWindow;
let dockerProcess = null;

// Docker container management
async function startIndexService() {
  try {
    console.log('Starting Azure Secrets Index Service...');
    
    // Use docker-compose up with quiet output
    const dockerProcess = spawn('docker-compose', ['up', '-d', '--quiet-pull'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true
    });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      dockerProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      dockerProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      dockerProcess.on('close', (code) => {
        if (code === 0) {
          console.log('Index service started successfully');
          resolve();
        } else {
          console.error('Failed to start index service:', stderr);
          reject(new Error(`Docker process exited with code ${code}`));
        }
      });

      dockerProcess.on('error', (error) => {
        console.error('Error starting index service:', error);
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error starting index service:', error);
    throw error;
  }
}

// Stop the index service container
async function stopIndexService() {
  try {
    console.log('Stopping Azure Secrets Index Service...');
    
    const dockerProcess = spawn('docker-compose', ['down', '--volumes', '--remove-orphans'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true
    });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      dockerProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      dockerProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      dockerProcess.on('close', (code) => {
        if (code === 0) {
          console.log('Index service stopped and container removed successfully');
          
          // Additional cleanup: remove any dangling containers or networks
          const cleanupProcess = spawn('docker', ['system', 'prune', '-f'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true
          });
          
          cleanupProcess.on('close', (cleanupCode) => {
            if (cleanupCode === 0) {
              console.log('Docker cleanup completed');
            }
            resolve();
          });
        } else {
          console.error('Failed to stop index service:', stderr);
          reject(new Error(`Docker-compose down failed with code ${code}: ${stderr}`));
        }
      });
    });
  } catch (error) {
    console.error('Error stopping index service:', error);
    throw error;
  }
}

// Check if index service is healthy
async function checkIndexServiceHealth() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/health',
      method: 'GET',
      timeout: 5000
    }, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    req.on('error', () => {
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false // Don't show until ready
  });

  // Load the index.html file
  mainWindow.loadFile('index.html');

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Open DevTools automatically to see console errors
    mainWindow.webContents.openDevTools();
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(async () => {
  try {
    // Start the index service before creating the window
    await startIndexService();
    
    // Wait for the service to be healthy
    let retries = 0;
    const maxRetries = 10;
    
    while (retries < maxRetries) {
      const isHealthy = await checkIndexServiceHealth();
      if (isHealthy) {
        console.log('Index service is healthy');
        break;
      }
      
      console.log(`Waiting for index service to be ready... (${retries + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      retries++;
    }
    
    if (retries >= maxRetries) {
      console.warn('Index service health check failed, but continuing...');
    }
    
    createWindow();
  } catch (error) {
    console.error('Failed to start index service:', error);
    // Continue without index service
    createWindow();
  }
});

app.on('window-all-closed', async () => {
  console.log('All windows closed, cleaning up...');
  
  // Stop and remove the index service container
  try {
    await stopIndexService();
    console.log('Index service container stopped and removed');
  } catch (error) {
    console.error('Failed to stop index service:', error);
  }
  
  // Quit the app
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async (event) => {
  console.log('App quitting, cleaning up...');
  
  // Prevent default quit behavior
  event.preventDefault();
  
  // Stop and remove the index service container
  try {
    await stopIndexService();
    console.log('Index service container stopped and removed');
  } catch (error) {
    console.error('Failed to stop index service:', error);
  }
  
  // Force quit after cleanup
  app.exit(0);
});

// Handle process termination
process.on('SIGINT', async () => {
  console.log('SIGINT received, cleaning up...');
  try {
    await stopIndexService();
    console.log('Index service container stopped and removed');
  } catch (error) {
    console.error('Failed to stop index service:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, cleaning up...');
  try {
    await stopIndexService();
    console.log('Index service container stopped and removed');
  } catch (error) {
    console.error('Failed to stop index service:', error);
  }
  process.exit(0);
});

// IPC handlers for Azure operations
ipcMain.handle('get-stored-subscriptions', () => {
  return store.get('subscriptions', []);
});

ipcMain.handle('save-subscriptions', (event, subscriptions) => {
  store.set('subscriptions', subscriptions);
  return true;
});

ipcMain.handle('get-stored-keyvaults', () => {
  return store.get('keyvaults', []);
});

ipcMain.handle('save-keyvaults', (event, keyvaults) => {
  store.set('keyvaults', keyvaults);
  return true;
});

// IPC handlers for index service
ipcMain.handle('index-service-health', async () => {
  return await checkIndexServiceHealth();
});

ipcMain.handle('index-service-status', async () => {
  try {
    const response = await fetch('http://localhost:3000/status');
    return await response.json();
  } catch (error) {
    console.error('Failed to get index service status:', error);
    return { error: error.message };
  }
});

ipcMain.handle('start-indexing', async () => {
  try {
    const response = await fetch('http://localhost:3000/index/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return await response.json();
  } catch (error) {
    console.error('Failed to start indexing:', error);
    return { error: error.message };
  }
});

ipcMain.handle('search-index', async (event, query) => {
  try {
    const response = await fetch('http://localhost:3000/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(query)
    });
    return await response.json();
  } catch (error) {
    console.error('Failed to search index:', error);
    return { error: error.message };
  }
});

ipcMain.handle('get-vault-data', async (event, vaultName) => {
  try {
    const response = await fetch(`http://localhost:3000/vault/${vaultName}`);
    return await response.json();
  } catch (error) {
    console.error('Failed to get vault data:', error);
    return { error: error.message };
  }
});

ipcMain.handle('get-indexed-vaults', async () => {
  try {
    const response = await fetch('http://localhost:3000/vaults');
    return await response.json();
  } catch (error) {
    console.error('Failed to get indexed vaults:', error);
    return { error: error.message };
  }
});

ipcMain.handle('get-security-status', async () => {
  try {
    const response = await fetch('http://localhost:3000/security');
    return await response.json();
  } catch (error) {
    console.error('Failed to get security status:', error);
    return { error: error.message };
  }
}); 