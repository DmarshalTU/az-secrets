# Azure Key Vault Tool - Architecture & User Interaction Flow

## Application Overview

The Azure Key Vault Tool is a .NET 9.0 console application that provides a full-screen, interactive interface for managing Azure Key Vault resources (secrets, keys, and certificates) using Azure CLI authentication.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Azure Key Vault Tool                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐  │
│  │   Program.cs    │    │  TerminalUI.cs  │    │     CacheManager.cs     │  │
│  │                 │    │                 │    │                         │  │
│  │ • Main Entry    │◄──►│ • Full-screen   │◄──►│ • Encrypted Local Cache │  │
│  │ • CLI Commands  │    │   UI Engine     │    │ • Global Search Index  │  │
│  │ • Auth Setup    │    │ • Navigation    │    │ • Expiration Alerts    │  │
│  │ • Error Handling│    │ • Input Handler │    │ • Cache Persistence    │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────────────┘  │
│           │                       │                       │                  │
│           │                       │                       │                  │
│           ▼                       ▼                       ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                        KeyVaultManager Class                           │  │
│  │                                                                         │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │  │
│  │  │  SecretClient   │  │   KeyClient     │  │   CertificateClient     │  │
│  │  │                 │  │                 │  │                         │  │
│  │  │ • List Secrets  │  │ • List Keys     │  │ • List Certificates     │  │
│  │  │ • Get Secret    │  │ • Get Key       │  │ • Get Certificate       │  │
│  │  │ • Set Secret    │  │ • Create Key    │  │ • Check Expiration      │  │
│  │  │ • Delete Secret │  │ • Delete Key    │  │ • Delete Certificate    │  │
│  │  │ • Search        │  │ • Search        │  │ • Search                │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
│  │                                                                         │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐    │  │
│  │  │                    Validation & Dry-Run                         │    │  │
│  │  │ • ValidateSecretOperation()    • ValidateKeyOperation()        │    │  │
│  │  │ • ValidateCertificateOperation() • ValidateResourceOperation() │    │  │
│  │  │ • DeleteResource()              • UpdateResource()             │    │  │
│  │  └─────────────────────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Azure Cloud Services                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐  │
│  │  Azure CLI      │    │  Azure Key      │    │   Azure Identity        │  │
│  │                 │    │   Vault         │    │                         │  │
│  │ • Authentication│◄──►│ • Secrets       │◄──►│ • DefaultAzureCredential│  │
│  │ • Subscriptions │    │ • Keys          │    │ • Token Management      │  │
│  │ • Resource List │    │ • Certificates  │    │ • Permission Validation │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## User Interaction Flow

```mermaid
graph TD
    A[Start Application] --> B{Command Line Args?}
    B -->|Yes| C[Direct Command Mode]
    B -->|No| D[Full-Screen Mode]
    
    C --> C1[Process Command]
    C1 --> C2[Execute & Exit]
    
    D --> E[Main Menu]
    E --> F[1. Global Search]
    E --> G[2. Vault Overview]
    E --> H[3. Select Vault]
    E --> I[4. Update Cache]
    E --> J[5. Show Alerts]
    E --> K[6. Cache Status]
    E --> L[7. Help]
    E --> M[ESC - Quit]
    
    F --> F1[Enter Search Term]
    F1 --> F2[Display Results]
    F2 --> F3[Select Resource]
    F3 --> F4[Show Details]
    F4 --> F5[Jump to Vault?]
    F5 -->|Yes| G
    F5 -->|No| E
    
    G --> G1{Vault Selected?}
    G1 -->|No| G2[Show "No Vault" Message]
    G1 -->|Yes| G3[Display Vault Overview]
    G2 --> E
    G3 --> G4[Resource Counts & Samples]
    G4 --> G5[Keyboard Shortcuts]
    G5 --> G6[S - Secrets]
    G5 --> G7[K - Keys]
    G5 --> G8[C - Certificates]
    G5 --> G9[G - Global Search]
    G5 --> G10[A - Alerts]
    G5 --> G11[ESC - Back]
    
    H --> H1[Select Subscription]
    H1 --> H2[Select Key Vault]
    H2 --> H3[Connect to Vault]
    H3 --> H4[Success?]
    H4 -->|Yes| G3
    H4 -->|No| H5[Show Error]
    H5 --> E
    
    I --> I1[Update Global Cache]
    I1 --> I2[Process All Subscriptions]
    I2 --> I3[Cache All Vaults]
    I3 --> E
    
    J --> J1[Check Expiring Certificates]
    J1 --> J2[Display Alerts]
    J2 --> E
    
    K --> K1[Show Cache Statistics]
    K1 --> E
    
    L --> L1[Display Help]
    L1 --> E
    
    G6 --> R1[Secrets View]
    G7 --> R2[Keys View]
    G8 --> R3[Certificates View]
    
    R1 --> R1A[Display Secrets List]
    R1A --> R1B[S - Search]
    R1B --> R1C[Search Results]
    R1C --> R1A
    R1A --> R1D[ESC - Back]
    R1D --> G3
    
    R2 --> R2A[Display Keys List]
    R2A --> R2B[S - Search]
    R2B --> R2C[Search Results]
    R2C --> R2A
    R2A --> R2D[ESC - Back]
    R2D --> G3
    
    R3 --> R3A[Display Certificates List]
    R3A --> R3B[S - Search]
    R3B --> R3C[Search Results]
    R3C --> R3A
    R3A --> R3D[ESC - Back]
    R3D --> G3
```

## Command Line Interface

### Basic Usage
```bash
dotnet run <vault-url> [command] [options]
```

### Available Commands

#### Resource Management
```bash
# Secrets
dotnet run https://myvault.vault.azure.net/ secrets list
dotnet run https://myvault.vault.azure.net/ secrets get my-secret
dotnet run https://myvault.vault.azure.net/ secrets set new-secret "value"

# Keys
dotnet run https://myvault.vault.azure.net/ keys list
dotnet run https://myvault.vault.azure.net/ keys get my-key
dotnet run https://myvault.vault.azure.net/ keys create new-key RSA

# Certificates
dotnet run https://myvault.vault.azure.net/ certs list
dotnet run https://myvault.vault.azure.net/ certs get my-cert
```

#### Search & Discovery
```bash
# Local search within current vault
dotnet run https://myvault.vault.azure.net/ local search my-resource

# Global search across all vaults
dotnet run https://myvault.vault.azure.net/ global search my-resource

# Search by type
dotnet run https://myvault.vault.azure.net/ search secret my-secret
```

#### Cache Management
```bash
# Update global cache
dotnet run https://myvault.vault.azure.net/ cache update

# Clear local cache
dotnet run https://myvault.vault.azure.net/ cache clear

# Show cache status
dotnet run https://myvault.vault.azure.net/ cache status
```

#### Safety & Validation
```bash
# Dry-run operations (preview without changes)
dotnet run https://myvault.vault.azure.net/ dry-run secrets set my-secret value
dotnet run https://myvault.vault.azure.net/ dry-run delete secrets my-secret

# Delete resources (with confirmation)
dotnet run https://myvault.vault.azure.net/ delete secrets my-secret
dotnet run https://myvault.vault.azure.net/ delete keys my-key

# Update resources
dotnet run https://myvault.vault.azure.net/ update keys my-key disable
dotnet run https://myvault.vault.azure.net/ update secrets my-secret "new-value"
```

#### Monitoring & Alerts
```bash
# Show expiring certificates
dotnet run https://myvault.vault.azure.net/ alerts list

# Check critical expirations
dotnet run https://myvault.vault.azure.net/ alerts check
```

#### Interactive Mode
```bash
# Start full-screen interactive mode
dotnet run https://myvault.vault.azure.net/ interactive

# Start full-screen mode without specific vault
dotnet run
```

## Full-Screen UI Navigation

### Main Menu Options
1. **🔍 Global Search** - Search across all vaults in all subscriptions
2. **📋 Vault Overview** - View current vault's resource summary
3. **🏗️ Select Vault** - Choose a vault from available subscriptions
4. **🔄 Update Cache** - Refresh global cache from all vaults
5. **⚠️ Show Alerts** - View expiring certificates
6. **📊 Cache Status** - View cache statistics
7. **❓ Help** - Display help information

### Vault Overview Shortcuts
- **S** - View Secrets
- **K** - View Keys  
- **C** - View Certificates
- **G** - Global Search
- **A** - Show Alerts
- **ESC** - Back to Main Menu

### Resource View Shortcuts
- **S** - Search within current view
- **R** - Refresh current view
- **ESC** - Back to Vault Overview

## Key Features

### 🔐 **Security**
- Azure CLI authentication (no stored credentials)
- Encrypted local cache (AES encryption with password prompt)
- Dry-run mode for safe operations
- Permission validation before operations

### 🔍 **Discovery & Search**
- Global search across all subscriptions and vaults
- Fuzzy search within individual vaults
- Cached metadata for fast searches
- Resource type filtering

### 📊 **Monitoring**
- Certificate expiration alerts
- Color-coded status indicators
- Cache statistics and health
- Resource counts and samples

### 🛡️ **Safety**
- Confirmation prompts for destructive operations
- Dry-run mode for previewing changes
- Comprehensive error handling
- Permission validation

### 🚀 **Performance**
- Local encrypted cache for fast searches
- Async operations for responsiveness
- Pagination for large resource sets
- Background cache updates

## Data Flow

```
User Input → TerminalUI → KeyVaultManager → Azure SDK → Azure Key Vault
     ↑                                                      ↓
     └─────────────── CacheManager ←────────────────────────┘
```

## Error Handling Strategy

1. **Authentication Errors** - Clear guidance to run `az login`
2. **Permission Errors** - Specific error messages with required permissions
3. **Network Errors** - Retry logic with exponential backoff
4. **Validation Errors** - Detailed feedback on what went wrong
5. **Resource Not Found** - Helpful suggestions for similar resources

## Cache Strategy

- **Encrypted Storage** - AES encryption with user-provided password
- **Metadata Only** - No sensitive data stored locally
- **Automatic Updates** - Background refresh of cache
- **Global Index** - Cross-subscription and cross-vault search capability
- **Expiration Tracking** - Certificate expiration monitoring 