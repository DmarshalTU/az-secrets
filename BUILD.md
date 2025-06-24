# Build Guide for Azure Secrets Explorer

This guide explains how to build Azure Secrets Explorer for Windows, macOS, and Linux.

## Prerequisites

### For All Platforms
- Node.js 16+ 
- npm or yarn
- Git

### Platform-Specific Requirements

#### Windows
- Windows 10/11 (for building Windows apps)
- Visual Studio Build Tools (optional, for native modules)

#### macOS
- macOS 10.15+ (for building macOS apps)
- Xcode Command Line Tools: `xcode-select --install`

#### Linux
- Ubuntu 18.04+ or similar distribution
- Required packages: `sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.0-dev libappindicator3-dev librsvg2-dev patchelf`

## Quick Start

### 1. Clone and Setup
```bash
git clone https://github.com/DmarshalTU/az-secrets.git
cd az-secrets
npm install
```

### 2. Prepare Icons (Required)
Before building, you need platform-specific icons:

#### macOS (.icns)
```bash
# Create iconset directory
mkdir -p assets/icon.iconset

# Generate different sizes (you can use online tools or ImageMagick)
# Then run:
iconutil -c icns assets/icon.iconset -o assets/icon.icns
```

#### Windows (.ico)
```bash
# Using ImageMagick (install with: brew install imagemagick)
convert assets/icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
```

#### Linux (.png)
- ✅ Already available as `assets/icon.png`

### 3. Build Commands

#### Build for Current Platform
```bash
npm run build
```

#### Build for Specific Platform
```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

#### Build for All Platforms
```bash
npm run build:all
```

#### Build for Specific Architecture
```bash
# Windows x64
npm run build:win-x64

# Windows ARM64
npm run build:win-arm64

# macOS x64
npm run build:mac-x64

# macOS ARM64 (Apple Silicon)
npm run build:mac-arm64

# Linux x64
npm run build:linux-x64

# Linux ARM64
npm run build:linux-arm64

# Linux ARMv7
npm run build:linux-armv7l
```

## Build Outputs

After building, you'll find the distributable files in the `dist/` directory:

### Windows
- `Azure Secrets Explorer Setup.exe` - NSIS installer
- `Azure Secrets Explorer.exe` - Portable executable

### macOS
- `Azure Secrets Explorer.dmg` - Disk image installer
- `Azure Secrets Explorer.app` - Application bundle (in zip)

### Linux
- `Azure Secrets Explorer.AppImage` - AppImage (portable)
- `az-secrets_1.0.0_amd64.deb` - Debian package
- `az-secrets-1.0.0.x86_64.rpm` - RPM package

## Automated Builds with GitHub Actions

The repository includes GitHub Actions workflows for automated builds:

### Manual Trigger
1. Go to Actions tab in GitHub
2. Select "Build and Release"
3. Click "Run workflow"
4. Choose branch and platform
5. Click "Run workflow"

### Automatic on Release
- Create a new release on GitHub
- Tag it with version (e.g., v1.0.0)
- GitHub Actions will automatically build and upload assets

## Troubleshooting

### Common Issues

#### "Icon file not found"
- Ensure you have the correct icon files in `assets/`:
  - `icon.icns` for macOS
  - `icon.ico` for Windows
  - `icon.png` for Linux

#### "Permission denied" on macOS
```bash
# Fix code signing issues
npm run build:mac -- --publish=never
```

#### "Missing dependencies" on Linux
```bash
# Install required packages
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.0-dev libappindicator3-dev librsvg2-dev patchelf
```

#### "Build fails on Windows"
- Ensure you're running as Administrator
- Install Visual Studio Build Tools if needed
- Try building with: `npm run build:win -- --publish=never`

### Performance Tips

#### Faster Builds
```bash
# Skip code signing for faster builds
npm run build:mac -- --publish=never

# Build only specific architecture
npm run build:win-x64
```

#### Clean Builds
```bash
# Clean previous builds
rm -rf dist/
rm -rf node_modules/
npm install
npm run build
```

## Publishing

### To GitHub Releases
1. Set up GitHub token in repository secrets
2. Create a release on GitHub
3. GitHub Actions will automatically upload builds

### Manual Publishing
```bash
# Build and publish to GitHub
npm run build -- --publish=always
```

## Development Builds

### Development Mode
```bash
npm run dev
```

### Packaged Development Build
```bash
npm run pack
```

## Code Signing (Optional)

### macOS
```bash
# Set up code signing certificate
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your_password
npm run build:mac
```

### Windows
```bash
# Set up code signing certificate
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your_password
npm run build:win
```

## Support

For build issues:
1. Check the troubleshooting section
2. Review GitHub Actions logs
3. Open an issue with build logs and system information

---

**Note**: This build process creates distributable packages that users can install on their systems. The built applications will require Azure CLI and proper authentication to function. 