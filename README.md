# Azure Key Vault Secrets Explorer

A modern, high-performance desktop application for searching and managing Azure Key Vault secrets and keys. Built with Electron and optimized for handling large-scale Azure environments with 100+ Key Vaults.

## 🚀 Performance Optimizations

This application has been specifically optimized to handle large numbers of Azure Key Vaults efficiently:

### Key Performance Improvements

1. **Lazy Loading**: Key Vaults are loaded on-demand rather than all at once
2. **Pagination**: Key Vaults are displayed in pages of 20 to prevent UI freezing
3. **Background Loading**: Data is loaded in the background without blocking the UI
4. **Caching**: Search results and vault data are cached for faster subsequent access
5. **Parallel Processing**: Multiple vaults are loaded simultaneously using Promise.all()
6. **Memory Management**: Automatic cleanup of old cache entries and search results
7. **Debounced Search**: Global search is debounced to prevent excessive API calls
8. **Batch Loading**: When searching all vaults, they're loaded in batches of 3 to avoid overwhelming the API

### Performance Metrics

The application includes real-time performance monitoring:

* Vault loading time tracking
* Search performance metrics
* Memory usage monitoring
* Cache hit rates
* Total items loaded

### Scalability Features

* **100+ Key Vaults**: Tested and optimized for environments with 100+ Key Vaults
* **1000+ Secrets/Keys**: Efficiently handles thousands of secrets and keys
* **Real-time Search**: Fast fuzzy search across all loaded data
* **Progressive Loading**: UI remains responsive while loading large datasets

## Features

### 🔍 Advanced Search

* **Global Search**: Search across all Key Vaults simultaneously
* **Fuzzy Search**: Intelligent pattern matching for secret and key names
* **Real-time Results**: Instant search results with caching
* **Search History**: Cached search results for faster subsequent searches
* **Search Scoring**: Results ranked by relevance with visual indicators

### 📊 Key Vault Management

* **Pagination**: Browse large numbers of Key Vaults efficiently
* **Status Indicators**: Visual indicators showing loaded vs unloaded vaults
* **Background Loading**: Load vault data without blocking the UI
* **Error Handling**: Graceful handling of access permission issues

### 🔐 Secret Management

* **Secure Display**: Secrets are hidden by default with toggle visibility
* **Edit Secrets**: In-place editing of secret values with proper validation
* **Bulk Operations**: Export, enable, disable, or delete multiple secrets
* **Version Management**: View and manage secret versions
* **Metadata Display**: Creation dates, expiration, and status information

### 🔑 Key Management

* **Key Types**: Support for RSA, EC, and OCT key types
* **Key Properties**: Display key size, type, and metadata
* **Status Tracking**: Monitor key enabled/disabled status
* **Bulk Operations**: Manage multiple keys simultaneously

### 📤 Export Capabilities

* **Multiple Formats**: Export to CSV, JSON, or plain text
* **Selective Export**: Choose specific secrets, keys, or all data
* **Value Inclusion**: Option to include or exclude secret values
* **Batch Export**: Export data from multiple vaults

## Installation

### Prerequisites

* Node.js 16+
* Azure CLI (for authentication)
* Azure subscription with Key Vault access

### Setup

```bash
# Clone the repository
git clone https://github.com/DmarshalTU/az-secrets.git
cd az-secrets

# Install dependencies
npm install

# Start the application
npm start

# For development with DevTools
npm run dev
```

### Azure Authentication

1. Install Azure CLI: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
2. Login to Azure: `az login`
3. Ensure your account has access to the Key Vaults you want to manage

## Usage

### Initial Setup

1. Launch the application
2. The app will automatically discover all accessible Key Vaults
3. Key Vaults are loaded progressively - only the first 5 are loaded initially
4. Click on a Key Vault to load its secrets and keys

### Searching

1. **Global Search**: Use the top search bar to search across all loaded vaults
2. **Vault Search**: Use the sidebar search to filter Key Vaults by name, location, or resource group
3. **Search All**: If no results found in loaded vaults, click "Search All Key Vaults" to load and search all vaults

### Managing Secrets

1. Select a Key Vault from the sidebar
2. Switch to the "Secrets" tab
3. View, edit, or delete secrets as needed
4. Use bulk operations for managing multiple secrets

### Managing Keys

1. Select a Key Vault from the sidebar
2. Switch to the "Keys" tab
3. View key properties and metadata
4. Perform bulk operations on keys

## Building and Distribution

### Quick Build

The easiest way to build the application is using the provided build scripts:

#### On macOS/Linux:
```bash
# Build for current platform
./build.sh

# Build for specific platform
./build.sh windows
./build.sh macos
./build.sh linux

# Build for all platforms
./build.sh all

# Clean build
./build.sh --clean all
```

#### On Windows:
```cmd
# Build for current platform
build.bat

# Build for specific platform
build.bat windows
build.bat macos
build.bat linux

# Build for all platforms
build.bat all

# Clean build
build.bat --clean all
```

### Manual Build

#### Prerequisites for Building

**All Platforms:**
- Node.js 16+
- npm or yarn

**Windows:**
- Windows 10/11 (for building Windows apps)
- Visual Studio Build Tools (optional, for native modules)

**macOS:**
- macOS 10.15+ (for building macOS apps)
- Xcode Command Line Tools: `xcode-select --install`

**Linux:**
- Ubuntu 18.04+ or similar distribution
- Required packages: `sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.0-dev libappindicator3-dev librsvg2-dev patchelf`

#### Build Commands

```bash
# Install dependencies
npm install

# Build for current platform
npm run build

# Build for specific platform
npm run build:win
npm run build:mac
npm run build:linux

# Build for all platforms
npm run build:all

# Build for specific architecture
npm run build:win-x64
npm run build:win-arm64
npm run build:mac-x64
npm run build:mac-arm64
npm run build:linux-x64
npm run build:linux-arm64
npm run build:linux-armv7l
```

### Build Outputs

After building, you'll find the distributable files in the `dist/` directory:

**Windows:**
- `Azure Secrets Explorer Setup.exe` - NSIS installer
- `Azure Secrets Explorer.exe` - Portable executable

**macOS:**
- `Azure Secrets Explorer.dmg` - Disk image installer
- `Azure Secrets Explorer.app` - Application bundle (in zip)

**Linux:**
- `Azure Secrets Explorer.AppImage` - AppImage (portable)
- `az-secrets_1.0.0_amd64.deb` - Debian package
- `az-secrets-1.0.0.x86_64.rpm` - RPM package

### Automated Builds with GitHub Actions

The repository includes GitHub Actions workflows for automated builds:

#### Manual Trigger
1. Go to Actions tab in GitHub
2. Select "Build and Release"
3. Click "Run workflow"
4. Choose branch and platform
5. Click "Run workflow"

#### Automatic on Release
- Create a new release on GitHub
- Tag it with version (e.g., v1.0.0)
- GitHub Actions will automatically build and upload assets

### Icon Requirements

Before building, ensure you have the correct icon files in `assets/`:

- `icon.icns` for macOS (512x512 or larger PNG converted to ICNS)
- `icon.ico` for Windows (multiple sizes: 16, 32, 48, 64, 128, 256)
- `icon.png` for Linux (512x512 or larger)

The build scripts will help you create these icons automatically.

## Performance Tips

### For Large Environments (100+ Key Vaults)

1. **Use Pagination**: Navigate through vaults using the pagination controls
2. **Search First**: Use global search to find specific items before loading all vaults
3. **Monitor Performance**: Watch the performance indicator in the bottom-left corner
4. **Clear Cache**: Restart the app periodically to clear accumulated cache

### For High-Security Environments

1. **Disable Value Display**: Use the export feature with "Exclude Values" option
2. **Audit Trail**: Monitor the console for access logs
3. **Regular Cleanup**: Clear search cache regularly to remove sensitive data from memory

## Troubleshooting

### Common Issues

**App becomes unresponsive with many vaults**
- Use pagination to browse vaults in smaller groups
- Use search to find specific items instead of loading all vaults
- Restart the app to clear memory cache

**Slow search performance**
- Ensure you're searching in loaded vaults first
- Use more specific search terms
- Clear search cache if it becomes too large

**Authentication errors**
- Verify Azure CLI is installed and you're logged in
- Check your Azure subscription permissions
- Ensure you have access to the Key Vaults you're trying to view

**Memory usage issues**
- The app automatically manages memory, but you can restart to clear cache
- Monitor the performance indicator for memory usage
- Use the search feature instead of loading all vaults at once

**Build issues**
- Check the [BUILD.md](BUILD.md) file for detailed build instructions
- Ensure all prerequisites are installed
- Try cleaning and rebuilding: `npm run build -- --clean`

## Development

### Building

```bash
# Build for current platform
npm run build

# Build for specific platforms
npm run build:mac
npm run build:win
npm run build:linux
```

### Performance Testing

The application includes built-in performance monitoring:

* Check the console for detailed performance logs
* Monitor the performance indicator in the UI
* Use browser DevTools to analyze memory usage

## Security Considerations

* **Local Storage**: Secret values are stored in memory only, not persisted to disk
* **Authentication**: Uses Azure's DefaultAzureCredential for secure authentication
* **Network**: All communication uses HTTPS with Azure's secure endpoints
* **Memory**: Sensitive data is cleared from memory when possible

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with large numbers of Key Vaults
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:

1. Check the troubleshooting section
2. Review the console logs for error details
3. Open an issue on GitHub with performance metrics and error details

---

**Note**: This application is designed for managing Azure Key Vaults in development and testing environments. For production use, ensure compliance with your organization's security policies and consider using Azure's official management tools for sensitive operations. 