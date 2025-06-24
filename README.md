# Azure Secrets Explorer

A modern, cross-platform desktop application for efficiently searching and managing Azure Key Vault secrets. Built with Electron and Azure SDK, this tool provides a much better user experience compared to the Azure Portal's cumbersome interface.

## Features

- 🔍 **Fuzzy Search**: Quickly find secrets by name or value with intelligent fuzzy matching
- 🖥️ **Cross-Platform**: Works on Windows, macOS, and Linux
- 🎨 **Modern UI**: Clean, responsive interface with dark mode support
- ⚡ **Fast Performance**: No more waiting for "Load More" buttons
- 🔐 **Secure**: Uses Azure's official SDK and authentication
- 💾 **Persistent Storage**: Remembers your subscriptions and Key Vaults
- 📋 **Copy to Clipboard**: One-click copying of secret values
- 👁️ **Show/Hide Values**: Toggle secret visibility for security
- ➕ **Add Secrets**: Create new secrets directly from the app

## Screenshots

The application features a clean sidebar for navigation and a main content area for displaying secrets with search functionality.

## Prerequisites

Before running the application, you need to:

1. **Install Azure CLI** (if not already installed):
   ```bash
   # macOS
   brew install azure-cli
   
   # Windows
   winget install Microsoft.AzureCLI
   
   # Linux
   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
   ```

2. **Login to Azure**:
   ```bash
   az login
   ```

3. **Set up permissions**: Ensure your account has access to the Key Vaults you want to manage.

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd az-secrets
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run the application**:
   ```bash
   npm start
   ```

## Development

To run the application in development mode with DevTools:

```bash
npm run dev
```

## Building

### For macOS:
```bash
npm run build:mac
```

### For Windows:
```bash
npm run build:win
```

### For Linux:
```bash
npm run build:linux
```

## Usage

1. **Launch the application** - The app will start with a welcome screen
2. **Select a subscription** - Click on a subscription in the sidebar to load its Key Vaults
3. **Choose a Key Vault** - Select a Key Vault to view its secrets
4. **Search secrets** - Use the search bar to find specific secrets using fuzzy search
5. **Manage secrets** - Copy values, toggle visibility, or delete secrets as needed

### Search Features

The fuzzy search works by:
- Matching characters in sequence (e.g., "db" matches "database-connection-string")
- Searching both secret names and values
- Case-insensitive matching
- Real-time filtering as you type

### Keyboard Shortcuts

- `Ctrl/Cmd + F`: Focus search input
- `Escape`: Clear search
- `Ctrl/Cmd + C`: Copy selected secret value

## Configuration

The application stores your preferences locally using `electron-store`. Data is stored in:
- **macOS**: `~/Library/Application Support/az-secrets/`
- **Windows**: `%APPDATA%\az-secrets\`
- **Linux**: `~/.config/az-secrets/`

## Security

- All Azure operations use the official Azure SDK
- Authentication is handled through Azure CLI or managed identity
- Secret values are hidden by default and can be toggled
- No secrets are stored locally - they're fetched on-demand

## Troubleshooting

### Common Issues

1. **"Failed to load subscriptions"**
   - Ensure you're logged in to Azure CLI: `az login`
   - Check your Azure account permissions

2. **"Failed to load Key Vaults"**
   - Verify your account has access to the subscription
   - Check if the subscription has any Key Vaults

3. **"Failed to load secrets"**
   - Ensure your account has Key Vault access policies configured
   - Check if the Key Vault has any secrets

### Authentication Methods

The application supports multiple authentication methods:
- Azure CLI authentication (recommended)
- Managed Identity (for Azure-hosted environments)
- Service Principal authentication

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Roadmap

- [ ] Support for Azure Key Vault Keys and Certificates
- [ ] Bulk operations (import/export secrets)
- [ ] Secret version management
- [ ] Integration with Azure DevOps pipelines
- [ ] Custom themes and UI customization
- [ ] Export secrets to various formats
- [ ] Secret rotation reminders
- [ ] Audit log viewing

## Support

If you encounter any issues or have questions, please:
1. Check the troubleshooting section above
2. Search existing issues on GitHub
3. Create a new issue with detailed information

## Acknowledgments

- Built with [Electron](https://electronjs.org/)
- Uses [Azure SDK for JavaScript](https://github.com/Azure/azure-sdk-for-js)
- Icons from [Font Awesome](https://fontawesome.com/) 