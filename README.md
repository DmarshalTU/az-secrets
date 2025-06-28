# Azure Key Vault Tool

A fast and convenient command-line tool for accessing Azure Key Vault resources (secrets, keys, and certificates) using Azure CLI authentication.

## Prerequisites

- .NET 9.0 or later
- Azure CLI installed and configured
- Azure subscription with Key Vault access

## Setup

1. **Install Azure CLI** (if not already installed):
   ```bash
   # On macOS
   brew install azure-cli
   ```

2. **Login to Azure**:
   ```bash
   az login
   ```

3. **Build the project**:
   ```bash
   dotnet build
   ```

## Usage

### Basic Syntax
```bash
dotnet run <vault-url> [command] [options]
```

### Examples

#### List all secrets in a Key Vault
```bash
dotnet run https://myvault.vault.azure.net/ secrets list
```

#### Get a specific secret
```bash
dotnet run https://myvault.vault.azure.net/ secrets get my-secret-name
```

#### Set a new secret
```bash
dotnet run https://myvault.vault.azure.net/ secrets set new-secret "secret-value"
```

#### List all keys
```bash
dotnet run https://myvault.vault.azure.net/ keys list
```

#### Get a specific key
```bash
dotnet run https://myvault.vault.azure.net/ keys get my-key-name
```

#### Create a new key
```bash
dotnet run https://myvault.vault.azure.net/ keys create new-key RSA
```

#### List all certificates
```bash
dotnet run https://myvault.vault.azure.net/ certs list
```

#### Get a specific certificate
```bash
dotnet run https://myvault.vault.azure.net/ certs get my-cert-name
```

#### Interactive Mode
```bash
dotnet run https://myvault.vault.azure.net/ interactive
```

## Interactive Mode

When running in interactive mode, you can use the following commands:

- `secrets list` - List all secrets
- `secrets get <name>` - Get a specific secret
- `secrets set <name> <value>` - Set a secret
- `keys list` - List all keys
- `keys get <name>` - Get a specific key
- `keys create <name> [type]` - Create a new key (RSA, EC, or OCT)
- `certs list` - List all certificates
- `certs get <name>` - Get a specific certificate
- `help` - Show available commands
- `exit` - Exit the application

## Authentication

The tool uses Azure CLI authentication via `DefaultAzureCredential`. This means:

1. It will automatically use your Azure CLI login session
2. No need to manage service principals or connection strings
3. Works seamlessly with your existing Azure CLI setup

## Key Vault URL Format

The Key Vault URL should be in the format:
```
https://<vault-name>.vault.azure.net/
```

## Supported Key Types

When creating keys, you can specify:
- `RSA` - RSA keys (default)
- `EC` - Elliptic Curve keys
- `OCT` - Octet keys

## Error Handling

The tool provides clear error messages for common issues:
- Authentication failures
- Missing permissions
- Invalid Key Vault URLs
- Resource not found errors

## Security Notes

- Secrets are displayed in plain text in the console
- Consider your terminal history when working with sensitive data
- The tool uses your Azure CLI credentials, so ensure your session is secure

## Troubleshooting

### Authentication Issues
```bash
# Re-login to Azure CLI
az login

# Check your current account
az account show
```

### Permission Issues
Ensure your Azure account has the necessary permissions on the Key Vault:
- `Get`, `List` for reading secrets/keys/certificates
- `Set` for creating secrets
- `Create` for creating keys

### Key Vault Access
Make sure the Key Vault exists and is accessible from your current Azure subscription:
```bash
# List your subscriptions
az account list --output table

# Set the correct subscription if needed
az account set --subscription <subscription-id>
``` 